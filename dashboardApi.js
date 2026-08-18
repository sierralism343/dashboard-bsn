// API internal -- HANYA dipanggil oleh dashboard web, bukan publik.
// Jalan di proses yang SAMA dengan bot, jadi bisa langsung baca/tulis `data` (data.json)
// dan akses `client` (koneksi Discord bot) tanpa perlu database terpisah.

const express = require('express');
const { getGuildData, saveData } = require('./storage');

function startInternalApi({ client, data, port, apiSecret, checkTopVoiceRoles, checkInviteAutoRole }) {
  const app = express();
  app.use(express.json());

  // Semua request WAJIB bawa header x-api-key yang cocok, kalau tidak ditolak.
  app.use((req, res, next) => {
    const key = req.header('x-api-key');
    if (!apiSecret || key !== apiSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, botTag: client.user ? client.user.tag : null });
  });

  // Ambil semua data yang dibutuhkan buat render halaman pengaturan satu server:
  // settingan yang sekarang tersimpan, PLUS daftar channel & role yang ada di server itu.
  app.get('/api/guilds/:guildId', async (req, res) => {
    const { guildId } = req.params;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Bot tidak ada di server ini' });

    const guildData = getGuildData(data, guildId);

    const textChannels = guild.channels.cache
      .filter(c => c.type === 0) // GuildText
      .map(c => ({ id: c.id, name: c.name }));

    const roles = guild.roles.cache
      .filter(r => r.name !== '@everyone' && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map(r => ({ id: r.id, name: r.name }));

    res.json({
      guildName: guild.name,
      settings: {
        leaderboardChannelId: guildData.leaderboardChannelId,
        leaderboardLimit: guildData.leaderboardLimit,
        inviteChannelId: guildData.inviteChannelId,
        achievementChannelId: guildData.achievementChannelId,
        roles: guildData.roles,               // auto-role voice (stay), berdasarkan menit
        inviteRoles: guildData.inviteRoles,    // auto-role invite, berdasarkan jumlah
        topVoiceStayRanks: guildData.topVoiceStayRanks,
        topVoiceActiveRanks: guildData.topVoiceActiveRanks,
      },
      textChannels,
      roles,
    });
  });

  // Update setting umum (channel leaderboard, invite log, achievement) sekaligus
  app.post('/api/guilds/:guildId/channels', (req, res) => {
    const { guildId } = req.params;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Bot tidak ada di server ini' });

    const guildData = getGuildData(data, guildId);
    const { leaderboardChannelId, leaderboardLimit, inviteChannelId, achievementChannelId } = req.body;

    if (leaderboardChannelId !== undefined) {
      guildData.leaderboardChannelId = leaderboardChannelId || null;
      guildData.lastLeaderboardMessageId = null;
    }
    if (leaderboardLimit !== undefined) guildData.leaderboardLimit = Math.min(Math.max(parseInt(leaderboardLimit) || 10, 1), 25);
    if (inviteChannelId !== undefined) guildData.inviteChannelId = inviteChannelId || null;
    if (achievementChannelId !== undefined) guildData.achievementChannelId = achievementChannelId || null;

    saveData(data);
    res.json({ ok: true, settings: guildData });
  });

  // Tambah/update aturan auto-role VOICE (berdasarkan menit)
  app.post('/api/guilds/:guildId/voice-roles', (req, res) => {
    const { guildId } = req.params;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Bot tidak ada di server ini' });

    const { roleId, minutes } = req.body;
    if (!roleId || !minutes) return res.status(400).json({ error: 'roleId dan minutes wajib diisi' });

    const guildData = getGuildData(data, guildId);
    const existing = guildData.roles.find(r => r.roleId === roleId);
    if (existing) existing.minutes = parseInt(minutes);
    else guildData.roles.push({ roleId, minutes: parseInt(minutes) });

    saveData(data);
    res.json({ ok: true, roles: guildData.roles });
  });

  app.delete('/api/guilds/:guildId/voice-roles/:roleId', (req, res) => {
    const { guildId, roleId } = req.params;
    const guildData = getGuildData(data, guildId);
    guildData.roles = guildData.roles.filter(r => r.roleId !== roleId);
    saveData(data);
    res.json({ ok: true, roles: guildData.roles });
  });

  // Tambah/update aturan auto-role INVITE (berdasarkan jumlah invite)
  app.post('/api/guilds/:guildId/invite-roles', async (req, res) => {
    const { guildId } = req.params;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Bot tidak ada di server ini' });

    const { roleId, count } = req.body;
    if (!roleId || !count) return res.status(400).json({ error: 'roleId dan count wajib diisi' });

    const guildData = getGuildData(data, guildId);
    const existing = guildData.inviteRoles.find(r => r.roleId === roleId);
    if (existing) existing.count = parseInt(count);
    else guildData.inviteRoles.push({ roleId, count: parseInt(count) });

    saveData(data);
    res.json({ ok: true, inviteRoles: guildData.inviteRoles });
  });

  app.delete('/api/guilds/:guildId/invite-roles/:roleId', (req, res) => {
    const { guildId, roleId } = req.params;
    const guildData = getGuildData(data, guildId);
    guildData.inviteRoles = guildData.inviteRoles.filter(r => r.roleId !== roleId);
    saveData(data);
    res.json({ ok: true, inviteRoles: guildData.inviteRoles });
  });

  // Setting role Top Voice (peringkat 1/2/3, stay/aktif)
  app.post('/api/guilds/:guildId/top-voice-roles', async (req, res) => {
    const { guildId } = req.params;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Bot tidak ada di server ini' });

    const { tipe, peringkat, roleId } = req.body; // tipe: 'stay' | 'aktif', peringkat: 1-3
    if (!tipe || !peringkat || !roleId) return res.status(400).json({ error: 'tipe, peringkat, dan roleId wajib diisi' });

    const guildData = getGuildData(data, guildId);
    const ranksKey = tipe === 'stay' ? 'topVoiceStayRanks' : 'topVoiceActiveRanks';
    guildData[ranksKey][peringkat - 1].roleId = roleId;
    guildData[ranksKey][peringkat - 1].holder = null;

    saveData(data);
    if (checkTopVoiceRoles) await checkTopVoiceRoles(guild);

    res.json({ ok: true, [ranksKey]: guildData[ranksKey] });
  });

  app.listen(port, () => {
    console.log(`API internal dashboard jalan di port ${port}`);
  });
}

module.exports = { startInternalApi };
