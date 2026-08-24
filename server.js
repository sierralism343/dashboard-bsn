require('dotenv').config();
const express = require('express');
const session = require('express-session');
const nodePath = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// File statis (logo, dsb) disajikan dari folder /public, contoh: /public/logo.png
app.use('/public', express.static(nodePath.join(__dirname, 'public')));

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_BOT_TOKEN,
  DISCORD_CALLBACK_URL,
  SESSION_SECRET,
} = process.env;

const ADMINISTRATOR_PERMISSION = 0x8; // bit permission Administrator di Discord
const BOT_INTERNAL_URL = process.env.BOT_INTERNAL_URL; // contoh: http://voicetrckbsn.railway.internal:4000
const DASHBOARD_API_SECRET = process.env.DASHBOARD_API_SECRET;

// Helper buat manggil API internal bot
async function callBotApi(path, options = {}) {
  const response = await fetch(`${BOT_INTERNAL_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': DASHBOARD_API_SECRET,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Bot API error ${response.status}: ${text}`);
  }
  return response.json();
}

app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: SESSION_SECRET || 'ganti-ini-di-env',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }, // 1 hari
}));

// Middleware sederhana: cek user sudah login atau belum
function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

// Izin bot yang diminta saat invite: Manage Roles, View Channels, Send Messages,
// Embed Links, Connect, Manage Server (dipakai fitur invite tracker) -- lihat PANDUAN.md
const BOT_INVITE_PERMISSIONS = '269503520';

function buildInviteUrl() {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    permissions: BOT_INVITE_PERMISSIONS,
    scope: 'bot applications.commands',
  });
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

// ===== Halaman utama (landing page publik) =====
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.send(renderLandingPage());
});

// ===== Mulai login: redirect ke halaman authorize Discord =====
app.get('/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_CALLBACK_URL,
    response_type: 'code',
    scope: 'identify guilds',
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

// ===== Discord redirect balik ke sini setelah user approve =====
app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/login');

  try {
    // Tukar "code" dengan access token
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_CALLBACK_URL,
      }),
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      console.error('Gagal tukar token:', errText);
      return res.status(500).send('Login gagal, coba lagi.');
    }

    const tokenData = await tokenResponse.json();

    // Ambil data user yang login
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = await userResponse.json();

    // Ambil daftar server yang dia punya izin admin
    const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const guildsData = await guildsResponse.json();

    const adminGuilds = guildsData.filter(g => (g.permissions & ADMINISTRATOR_PERMISSION) === ADMINISTRATOR_PERMISSION);

    req.session.user = {
      id: userData.id,
      username: userData.username,
      avatar: userData.avatar,
    };
    req.session.adminGuilds = adminGuilds;

    res.redirect('/dashboard');
  } catch (err) {
    console.error('Error waktu callback OAuth2:', err);
    res.status(500).send('Terjadi kesalahan, coba lagi nanti.');
  }
});

// ===== Halaman dashboard: daftar server yang bisa dikelola =====
app.get('/dashboard', requireLogin, async (req, res) => {
  const { user, adminGuilds } = req.session;

  // Cek server mana yang bot-nya beneran ada di situ (pakai bot token)
  let botGuildIds = new Set();
  try {
    const botGuildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
    });
    const botGuilds = await botGuildsResponse.json();
    botGuildIds = new Set(botGuilds.map(g => g.id));
  } catch (err) {
    console.error('Gagal cek daftar server bot:', err.message);
  }

  const guildListHtml = adminGuilds.map(g => {
    const iconUrl = g.icon
      ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png`
      : 'https://cdn.discordapp.com/embed/avatars/0.png';
    const botAda = botGuildIds.has(g.id);
    return `
      <div class="server-card">
        <img src="${iconUrl}" alt="${g.name}" />
        <div class="server-info">
          <strong>${g.name}</strong>
          ${botAda
            ? `<a class="btn-small" href="/server/${g.id}">Kelola</a>`
            : `<span class="badge-warn">Bot belum diinvite ke server ini</span>`}
        </div>
      </div>
    `;
  }).join('');

  res.send(renderPage(`
    <div class="topbar">
      <span>Halo, ${user.username}</span>
      <a href="/logout">Logout</a>
    </div>
    <h2>Pilih server yang mau dikelola</h2>
    <div class="server-list">
      ${guildListHtml || '<p>Kamu tidak punya akses admin di server manapun yang punya bot ini.</p>'}
    </div>
  `));
});

// Middleware: pastikan user beneran admin di guild ini (bukan asal tebak guildId di URL)
function requireGuildAdmin(req, res, next) {
  const { guildId } = req.params;
  const isAdmin = (req.session.adminGuilds || []).some(g => g.id === guildId);
  if (!isAdmin) return res.status(403).send(renderPage('<p>Kamu tidak punya akses admin di server ini.</p>'));
  next();
}

function channelOptions(channels, selectedId) {
  const blank = `<option value="">-- Belum diatur --</option>`;
  const opts = channels.map(c =>
    `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>#${c.name}</option>`
  ).join('');
  return blank + opts;
}

function roleOptions(roles, selectedId) {
  return roles.map(r => `<option value="${r.id}" ${r.id === selectedId ? 'selected' : ''}>${r.name}</option>`).join('');
}

// ===== Halaman pengaturan per-server =====
app.get('/server/:guildId', requireLogin, requireGuildAdmin, async (req, res) => {
  const { guildId } = req.params;
  let info;
  try {
    info = await callBotApi(`/api/guilds/${guildId}`);
  } catch (err) {
    console.error('Gagal ambil data dari bot API:', err.message);
    return res.send(renderPage(`
      <div class="topbar"><a href="/dashboard">&larr; Kembali</a></div>
      <p>Gagal konek ke bot. Pastikan bot online dan BOT_INTERNAL_URL / DASHBOARD_API_SECRET sudah benar.</p>
    `));
  }

  const { guildName, settings, textChannels, roles } = info;

  const voiceRoleRows = settings.roles.map(r => `
    <div class="row-item">
      <span>${roles.find(x => x.id === r.roleId)?.name || r.roleId} — min ${r.minutes} menit</span>
      <form method="POST" action="/server/${guildId}/voice-roles/${r.roleId}/delete">
        <button class="btn-danger" type="submit">Hapus</button>
      </form>
    </div>
  `).join('') || '<p class="muted">Belum ada aturan.</p>';

  const inviteRoleRows = settings.inviteRoles.map(r => `
    <div class="row-item">
      <span>${roles.find(x => x.id === r.roleId)?.name || r.roleId} — min ${r.count} invite</span>
      <form method="POST" action="/server/${guildId}/invite-roles/${r.roleId}/delete">
        <button class="btn-danger" type="submit">Hapus</button>
      </form>
    </div>
  `).join('') || '<p class="muted">Belum ada aturan.</p>';

  function topVoiceRow(tipe, label, ranks) {
    return [1, 2, 3].map(peringkat => {
      const slot = ranks[peringkat - 1];
      const currentRoleName = slot.roleId ? (roles.find(x => x.id === slot.roleId)?.name || slot.roleId) : '(belum diatur)';
      return `
        <form method="POST" action="/server/${guildId}/top-voice-roles" class="row-item">
          <input type="hidden" name="tipe" value="${tipe}" />
          <input type="hidden" name="peringkat" value="${peringkat}" />
          <span>${label} — Peringkat ${peringkat}: <strong>${currentRoleName}</strong></span>
          <select name="roleId">
            <option value="">-- Pilih role --</option>
            ${roleOptions(roles, slot.roleId)}
          </select>
          <button class="btn-small" type="submit">Simpan</button>
        </form>
      `;
    }).join('');
  }

  res.send(renderPage(`
    <div class="topbar">
      <a href="/dashboard">&larr; Kembali</a>
    </div>
    <h2>Pengaturan: ${guildName}</h2>

    <div class="card">
      <h3>Channel Utama</h3>
      <form method="POST" action="/server/${guildId}/channels">
        <label>Channel Leaderboard (auto-post 4x sehari)</label>
        <select name="leaderboardChannelId">${channelOptions(textChannels, settings.leaderboardChannelId)}</select>

        <label>Jumlah ditampilkan per kategori</label>
        <input type="number" name="leaderboardLimit" min="1" max="25" value="${settings.leaderboardLimit || 10}" />

        <label>Channel Invite Log (warga baru/keluar)</label>
        <select name="inviteChannelId">${channelOptions(textChannels, settings.inviteChannelId)}</select>

        <label>Channel Pengumuman Pencapaian</label>
        <select name="achievementChannelId">${channelOptions(textChannels, settings.achievementChannelId)}</select>

        <button class="btn" type="submit">Simpan Channel</button>
      </form>
    </div>

    <div class="card">
      <h3>Auto-Role Voice (berdasarkan menit)</h3>
      ${voiceRoleRows}
      <form method="POST" action="/server/${guildId}/voice-roles" class="row-item">
        <select name="roleId" required><option value="">-- Pilih role --</option>${roleOptions(roles)}</select>
        <input type="number" name="minutes" placeholder="Menit" min="1" required />
        <button class="btn-small" type="submit">Tambah</button>
      </form>
    </div>

    <div class="card">
      <h3>Auto-Role Invite (berdasarkan jumlah invite)</h3>
      ${inviteRoleRows}
      <form method="POST" action="/server/${guildId}/invite-roles" class="row-item">
        <select name="roleId" required><option value="">-- Pilih role --</option>${roleOptions(roles)}</select>
        <input type="number" name="count" placeholder="Jumlah invite" min="1" required />
        <button class="btn-small" type="submit">Tambah</button>
      </form>
    </div>

    <div class="card">
      <h3>Role Top Voice (Peringkat 1/2/3)</h3>
      <p class="muted">Voice Stay</p>
      ${topVoiceRow('stay', 'Voice Stay', settings.topVoiceStayRanks)}
      <p class="muted">Voice Aktif</p>
      ${topVoiceRow('aktif', 'Voice Aktif', settings.topVoiceActiveRanks)}
    </div>
  `));
});

app.post('/server/:guildId/channels', requireLogin, requireGuildAdmin, async (req, res) => {
  const { guildId } = req.params;
  try {
    await callBotApi(`/api/guilds/${guildId}/channels`, {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  } catch (err) {
    console.error('Gagal simpan channel settings:', err.message);
  }
  res.redirect(`/server/${guildId}`);
});

app.post('/server/:guildId/voice-roles', requireLogin, requireGuildAdmin, async (req, res) => {
  const { guildId } = req.params;
  try {
    await callBotApi(`/api/guilds/${guildId}/voice-roles`, {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  } catch (err) {
    console.error('Gagal tambah voice role:', err.message);
  }
  res.redirect(`/server/${guildId}`);
});

app.post('/server/:guildId/voice-roles/:roleId/delete', requireLogin, requireGuildAdmin, async (req, res) => {
  const { guildId, roleId } = req.params;
  try {
    await callBotApi(`/api/guilds/${guildId}/voice-roles/${roleId}`, { method: 'DELETE' });
  } catch (err) {
    console.error('Gagal hapus voice role:', err.message);
  }
  res.redirect(`/server/${guildId}`);
});

app.post('/server/:guildId/invite-roles', requireLogin, requireGuildAdmin, async (req, res) => {
  const { guildId } = req.params;
  try {
    await callBotApi(`/api/guilds/${guildId}/invite-roles`, {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  } catch (err) {
    console.error('Gagal tambah invite role:', err.message);
  }
  res.redirect(`/server/${guildId}`);
});

app.post('/server/:guildId/invite-roles/:roleId/delete', requireLogin, requireGuildAdmin, async (req, res) => {
  const { guildId, roleId } = req.params;
  try {
    await callBotApi(`/api/guilds/${guildId}/invite-roles/${roleId}`, { method: 'DELETE' });
  } catch (err) {
    console.error('Gagal hapus invite role:', err.message);
  }
  res.redirect(`/server/${guildId}`);
});

app.post('/server/:guildId/top-voice-roles', requireLogin, requireGuildAdmin, async (req, res) => {
  const { guildId } = req.params;
  const { tipe, peringkat, roleId } = req.body;
  if (roleId) {
    try {
      await callBotApi(`/api/guilds/${guildId}/top-voice-roles`, {
        method: 'POST',
        body: JSON.stringify({ tipe, peringkat: parseInt(peringkat), roleId }),
      });
    } catch (err) {
      console.error('Gagal simpan top voice role:', err.message);
    }
  }
  res.redirect(`/server/${guildId}`);
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

function renderPage(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <title>Dashboard Badan Statistik Nasional</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, 'Segoe UI', sans-serif;
      background: radial-gradient(circle at 30% 20%, #1e3a5f, #0b1f38 70%);
      color: #f4d47a;
      min-height: 100vh;
      padding: 40px 20px;
    }
    a { color: #f4d47a; }
    .hero { max-width: 480px; margin: 80px auto; text-align: center; }
    .hero h1 { font-size: 28px; margin-bottom: 12px; }
    .hero p { color: #cbd5e1; margin-bottom: 24px; }
    .btn, .btn-small {
      display: inline-block;
      background: linear-gradient(135deg, #f4d47a, #b8862f);
      color: #0b1f38;
      font-weight: bold;
      padding: 12px 28px;
      border-radius: 8px;
      text-decoration: none;
    }
    .btn-small { padding: 6px 14px; font-size: 13px; }
    .topbar {
      display: flex;
      justify-content: space-between;
      max-width: 700px;
      margin: 0 auto 24px;
    }
    h2 { max-width: 700px; margin: 0 auto 16px; }
    .server-list { max-width: 700px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
    .server-card {
      display: flex;
      align-items: center;
      gap: 16px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(244,212,122,0.3);
      border-radius: 10px;
      padding: 12px 16px;
    }
    .server-card img { width: 48px; height: 48px; border-radius: 50%; }
    .server-info { display: flex; justify-content: space-between; align-items: center; flex: 1; color: #fff; }
    .badge-warn { color: #ff8a5c; font-size: 13px; }

    .card {
      max-width: 700px;
      margin: 0 auto 20px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(244,212,122,0.3);
      border-radius: 10px;
      padding: 16px 20px;
    }
    .card h3 { margin-top: 0; color: #fff; }
    .card label { display: block; margin: 12px 0 4px; font-size: 13px; color: #cbd5e1; }
    .card select, .card input[type=number], .card input[type=text] {
      width: 100%;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid rgba(244,212,122,0.3);
      background: #0b1f38;
      color: #fff;
    }
    .row-item {
      display: flex;
      align-items: center;
      gap: 10px;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      color: #fff;
      font-size: 14px;
    }
    .row-item select { flex: 1; }
    .muted { color: #94a3b8; font-size: 13px; margin: 10px 0 4px; }
    .btn-danger {
      background: #ef4444;
      color: #fff;
      border: none;
      padding: 5px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
    }
  </style>
</head>
<body>
  ${bodyHtml}
</body>
</html>`;
}

// ===== Landing page publik: brand "Badan Statistik Nasional" (BSN) =====
function renderLandingPage() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Badan Statistik Nasional — Dashboard Bot Discord</title>
<meta name="description" content="BSN mencatat aktivitas voice dan undangan tiap member di server Discord kamu, lalu otomatis kasih role dan leaderboard.">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500&display=swap');
  :root {
    --bg: #0a1128;
    --card: #10173a;
    --border: #232b52;
    --text: #f5f2ea;
    --text-dim: #9a958c;
    --coral: #f0703c;
    --gold: #c9a24b;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', -apple-system, sans-serif;
    background-image: radial-gradient(circle at 1px 1px, rgba(255,255,255,0.045) 1px, transparent 0);
    background-size: 26px 26px;
    min-height: 100vh;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    max-width: 1120px;
    margin: 0 auto;
    padding: 28px 24px 0;
  }
  .logo { display: flex; align-items: center; gap: 12px; }
  .logo img { width: 38px; height: 38px; }
  .logo-text {
    font-family: 'Oswald', sans-serif;
    font-weight: 600;
    font-size: 15px;
    letter-spacing: 0.5px;
  }
  .logo-text small {
    display: block;
    font-family: 'Inter', sans-serif;
    font-weight: 400;
    font-size: 10px;
    letter-spacing: 2px;
    color: var(--text-dim);
    margin-top: 1px;
  }
  nav { display: flex; gap: 34px; }
  nav a { color: var(--text-dim); text-decoration: none; font-size: 14px; font-weight: 500; }
  nav a:hover { color: var(--text); }
  .login-btn {
    border: 1px solid var(--gold);
    color: var(--gold);
    padding: 8px 20px;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
  }
  main { max-width: 760px; margin: 90px auto 0; text-align: center; padding: 0 24px; }
  .eyebrow {
    font-family: 'JetBrains Mono', monospace;
    color: var(--coral);
    font-size: 12px;
    letter-spacing: 4px;
    font-weight: 500;
    margin-bottom: 24px;
  }
  h1 { font-family: 'Oswald', sans-serif; font-weight: 700; font-size: 52px; line-height: 1.15; letter-spacing: -0.5px; }
  h1 .em { color: var(--coral); }
  .subtitle { color: var(--text-dim); font-size: 16px; line-height: 1.65; max-width: 540px; margin: 24px auto 34px; }
  .stats-row {
    display: flex;
    justify-content: center;
    margin: 0 auto 36px;
    max-width: 560px;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    padding: 20px 0;
  }
  .stat { flex: 1; padding: 0 18px; }
  .stat + .stat { border-left: 1px solid var(--border); }
  .stat .num { font-family: 'JetBrains Mono', monospace; font-size: 20px; font-weight: 500; color: var(--gold); }
  .stat .label { font-size: 11px; color: var(--text-dim); margin-top: 4px; letter-spacing: 0.3px; }
  .cta-row { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; margin-bottom: 90px; }
  .btn { padding: 13px 26px; border-radius: 4px; font-weight: 600; font-size: 15px; text-decoration: none; display: inline-block; }
  .btn-primary { background: var(--coral); color: #fff; }
  .btn-secondary { background: transparent; color: var(--text); border: 1px solid rgba(255,255,255,0.25); }
  @media (max-width: 720px) {
    nav { display: none; }
    h1 { font-size: 36px; }
  }
</style>
</head>
<body>

<header>
  <div class="logo">
    <img src="/public/logo.png" alt="BSN">
    <div class="logo-text">BADAN STATISTIK NASIONAL<small>SENSUS SETIAP SERVER DISCORD</small></div>
  </div>
  <nav>
    <a href="/">Beranda</a>
    <a href="#fitur">Fitur</a>
    <a href="https://github.com" target="_blank" rel="noopener">Dokumentasi</a>
  </nav>
  <a href="/login" class="login-btn">Login</a>
</header>

<main>
  <div class="eyebrow">SENSUS DIGITAL</div>
  <h1>Setiap member,<br><span class="em">tercatat resmi.</span></h1>
  <p class="subtitle">
    BSN mencatat aktivitas voice dan undangan tiap member di server Discord kamu,
    lalu otomatis kasih role dan leaderboard — satu bot, semua server.
  </p>

  <div class="stats-row">
    <div class="stat"><div class="num">3</div><div class="label">SERVER TERDAFTAR</div></div>
    <div class="stat"><div class="num">24/7</div><div class="label">PENCATATAN AKTIF</div></div>
  </div>

  <div class="cta-row">
    <a href="${buildInviteUrl()}" class="btn btn-primary">➕ Tambahkan ke Server</a>
    <a href="/login" class="btn btn-secondary">Buka Dashboard</a>
  </div>
</main>

</body>
</html>`;
}

app.listen(PORT, () => {
  console.log(`Dashboard jalan di port ${PORT}`);
});
