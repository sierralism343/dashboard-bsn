require('dotenv').config();
const express = require('express');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_BOT_TOKEN,
  DISCORD_CALLBACK_URL,
  SESSION_SECRET,
} = process.env;

const ADMINISTRATOR_PERMISSION = 0x8; // bit permission Administrator di Discord

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

// ===== Halaman utama =====
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.send(renderPage(`
    <div class="hero">
      <h1>Dashboard Badan Statistik Nasional</h1>
      <p>Kelola pengaturan bot voice tracker & invite tracker langsung dari web, tanpa perlu hafal command.</p>
      <a class="btn" href="/login">Login dengan Discord</a>
    </div>
  `));
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

// ===== Halaman pengaturan per-server (placeholder, dikembangkan bertahap) =====
app.get('/server/:guildId', requireLogin, (req, res) => {
  const { guildId } = req.params;
  res.send(renderPage(`
    <div class="topbar">
      <a href="/dashboard">&larr; Kembali</a>
    </div>
    <h2>Pengaturan Server</h2>
    <p>Guild ID: ${guildId}</p>
    <p><em>Halaman pengaturan detail (leaderboard, invite roles, dll) akan ditambahkan di tahap berikutnya.</em></p>
  `));
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
  </style>
</head>
<body>
  ${bodyHtml}
</body>
</html>`;
}

app.listen(PORT, () => {
  console.log(`Dashboard jalan di port ${PORT}`);
});
