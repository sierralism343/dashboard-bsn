require('dotenv').config();
const { startInternalApi } = require('./dashboardApi');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const cron = require('node-cron');
const {
  loadData,
  saveData,
  getGuildData,
  getUserData,
  formatDuration,
} = require('./storage');
const {
  cacheGuildInvites,
  updateCacheOnCreate,
  updateCacheOnDelete,
  findInviteUsed,
} = require('./inviteTracker');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
  ],
});

let data = loadData();

// Simpan data ke disk setiap 30 detik, sekaligus cek pemimpin top voice (stay & aktif)
setInterval(() => {
  saveData(data);
  for (const guild of client.guilds.cache.values()) {
    checkTopVoiceRoles(guild).catch(err => console.error('Gagal cek top voice role:', err.message));
  }
}, 30 * 1000);

function endSession(guildId, userId) {
  const guildData = getGuildData(data, guildId);
  const userData = getUserData(guildData, userId);
  if (userData.sessionStart) {
    const elapsed = (Date.now() - userData.sessionStart) / 1000;
    userData.totalSeconds += elapsed;
    userData.sessionStart = null;
  }
}

function startSession(guildId, userId) {
  const guildData = getGuildData(data, guildId);
  const userData = getUserData(guildData, userId);
  userData.sessionStart = Date.now();
}

function endActiveSession(guildId, userId) {
  const guildData = getGuildData(data, guildId);
  const userData = getUserData(guildData, userId);
  if (userData.activeSessionStart) {
    const elapsed = (Date.now() - userData.activeSessionStart) / 1000;
    userData.activeSeconds += elapsed;
    userData.activeSessionStart = null;
  }
}

function startActiveSession(guildId, userId) {
  const guildData = getGuildData(data, guildId);
  const userData = getUserData(guildData, userId);
  userData.activeSessionStart = Date.now();
}

// "Aktif" = mic terbuka (tidak mute) DAN deafen terbuka (tidak deafen), server-imposed atau self, keduanya dihitung
function isActiveVoiceState(voiceState) {
  if (!voiceState) return false;
  return !voiceState.mute && !voiceState.deaf;
}

async function checkAutoRole(guild, member) {
  const guildData = getGuildData(data, guild.id);
  const userData = getUserData(guildData, member.id);
  const totalMinutes = userData.totalSeconds / 60;

  for (const rule of guildData.roles) {
    if (totalMinutes >= rule.minutes) {
      if (!member.roles.cache.has(rule.roleId)) {
        try {
          await member.roles.add(rule.roleId);
        } catch (err) {
          console.error(`Gagal menambahkan role ${rule.roleId} ke ${member.id}:`, err.message);
        }
      }
    }
  }
}

async function postAchievement(guild, guildData, message) {
  if (!guildData.achievementChannelId) return;
  try {
    const channel = await guild.channels.fetch(guildData.achievementChannelId);
    if (channel && channel.type === ChannelType.GuildText) {
      await channel.send(message);
    }
  } catch (err) {
    console.error(`Gagal kirim pesan achievement ke channel ${guildData.achievementChannelId}:`, err.message);
  }
}

async function checkInviteAutoRole(guild, userId) {
  const guildData = getGuildData(data, guild.id);
  const inviteCount = guildData.invites[userId] || 0;
  if (!guildData.inviteRoles || guildData.inviteRoles.length === 0) return;

  let member;
  try {
    member = await guild.members.fetch(userId);
  } catch (err) {
    return; // Member mungkin sudah keluar server, aman diabaikan
  }

  // Cari role tier invite yang saat ini dipegang member (kalau ada) -- buat deteksi kenaikan level
  const currentRule = guildData.inviteRoles.find(rule => member.roles.cache.has(rule.roleId));

  // Cari tier tertinggi yang sudah dicapai (urutkan dari yang paling besar syaratnya)
  const sortedRules = [...guildData.inviteRoles].sort((a, b) => b.count - a.count);
  const targetRule = sortedRules.find(rule => inviteCount >= rule.count);

  // Copot semua role tier invite LAIN yang member ini pegang (bukan tier target),
  // supaya cuma role tertinggi yang nempel -- tidak dobel.
  for (const rule of guildData.inviteRoles) {
    const isTargetRole = targetRule && rule.roleId === targetRule.roleId;
    if (!isTargetRole && member.roles.cache.has(rule.roleId)) {
      try {
        await member.roles.remove(rule.roleId);
      } catch (err) {
        console.error(`Gagal mencopot invite role lama ${rule.roleId} dari ${userId}:`, err.message);
      }
    }
  }

  // Tambahkan role tier tertinggi kalau belum dipegang
  const isLevelUp = targetRule && (!currentRule || targetRule.count > currentRule.count);
  if (targetRule && !member.roles.cache.has(targetRule.roleId)) {
    try {
      await member.roles.add(targetRule.roleId);
      if (isLevelUp) {
        await postAchievement(
          guild,
          guildData,
          `🎉 Selamat kepada ${member} yang naik tingkat jadi <@&${targetRule.roleId}> berkat **${inviteCount}** undangan! Terima kasih sudah membantu +62 Society berkembang.`
        );
      }
    } catch (err) {
      console.error(`Gagal menambahkan invite role ${targetRule.roleId} ke ${userId}:`, err.message);
    }
  }
}

function buildVoiceLeaderboardLines(guildData, limit, field) {
  const entries = Object.entries(guildData.users).map(([userId, u]) => {
    let liveSeconds = u[field] || 0;
    const sessionField = field === 'activeSeconds' ? 'activeSessionStart' : 'sessionStart';
    if (u[sessionField]) liveSeconds += (Date.now() - u[sessionField]) / 1000;
    return { userId, seconds: liveSeconds };
  });

  entries.sort((a, b) => b.seconds - a.seconds);
  const top = entries.filter(e => e.seconds > 0).slice(0, limit);

  if (top.length === 0) return ['Belum ada data.'];
  return top.map((entry, i) => {
    const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
    return `${medal} <@${entry.userId}> — **${formatDuration(entry.seconds)}**`;
  });
}

function getTopVoiceUserIds(guildData, field, limit = 3) {
  const entries = Object.entries(guildData.users).map(([userId, u]) => {
    let liveSeconds = u[field] || 0;
    const sessionField = field === 'activeSeconds' ? 'activeSessionStart' : 'sessionStart';
    if (u[sessionField]) liveSeconds += (Date.now() - u[sessionField]) / 1000;
    return { userId, seconds: liveSeconds };
  });
  entries.sort((a, b) => b.seconds - a.seconds);
  return entries.filter(e => e.seconds > 0).slice(0, limit).map(e => e.userId);
}

async function checkTopVoiceRoleForField(guild, guildData, field, ranksKey, label) {
  const ranks = guildData[ranksKey];
  if (!ranks || ranks.every(r => !r.roleId)) return; // Belum ada role yang diset sama sekali

  const topUserIds = getTopVoiceUserIds(guildData, field, 3);

  // Catat posisi peringkat tiap orang SEBELUM diupdate, buat bedain "naik peringkat" vs "kesalip/turun"
  const oldPositions = {};
  ranks.forEach((slot, idx) => {
    if (slot.holder) oldPositions[slot.holder] = idx;
  });

  for (let i = 0; i < 3; i++) {
    const rankSlot = ranks[i];
    if (!rankSlot.roleId) continue; // Peringkat ini belum diset role-nya, skip

    const newHolder = topUserIds[i] || null;
    const oldHolder = rankSlot.holder;

    if (newHolder === oldHolder) continue; // Tidak ada perubahan di peringkat ini

    // Copot role dari pemegang lama peringkat ini (kalau ada)
    if (oldHolder) {
      try {
        const oldMember = await guild.members.fetch(oldHolder);
        if (oldMember.roles.cache.has(rankSlot.roleId)) {
          await oldMember.roles.remove(rankSlot.roleId);
        }
      } catch (err) {
        // Member lama mungkin sudah keluar server, aman diabaikan
      }
    }

    rankSlot.holder = newHolder;
    saveData(data);

    // Kasih role ke pemegang baru peringkat ini (kalau ada), dan kirim pengumuman.
    // Beda kata-kata tergantung ini KENAIKAN (naik peringkat / baru masuk top-3)
    // atau cuma "kedorong turun" ke slot ini karena kesalip orang lain.
    if (newHolder) {
      const previousRank = oldPositions[newHolder]; // undefined kalau belum pernah masuk top-3
      const isPromotion = previousRank === undefined || previousRank > i;

      try {
        const newMember = await guild.members.fetch(newHolder);
        await newMember.roles.add(rankSlot.roleId);
        if (isPromotion) {
          await postAchievement(
            guild,
            guildData,
            `🏆 ${newMember} baru saja menyusul jadi **Peringkat ${i + 1} ${label}** dan mendapat role <@&${rankSlot.roleId}>! Selamat! 🎉`
          );
        } else {
          await postAchievement(
            guild,
            guildData,
            `📉 ${newMember} tergeser ke **Peringkat ${i + 1} ${label}** (role <@&${rankSlot.roleId}>) setelah disalip member lain. Semangat lagi ya!`
          );
        }
      } catch (err) {
        console.error(`Gagal memberikan top voice role ${rankSlot.roleId} ke ${newHolder}:`, err.message);
      }
    }
  }
}

async function checkTopVoiceRoles(guild) {
  const guildData = getGuildData(data, guild.id);
  await checkTopVoiceRoleForField(guild, guildData, 'totalSeconds', 'topVoiceStayRanks', 'Voice Stay');
  await checkTopVoiceRoleForField(guild, guildData, 'activeSeconds', 'topVoiceActiveRanks', 'Voice Aktif');
}

function buildInviteLeaderboardLines(guildData, limit) {
  const entries = Object.entries(guildData.invites || {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  if (entries.length === 0) return ['Belum ada data.'];
  return entries.map(([userId, count], i) => {
    const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
    return `${medal} <@${userId}> — **${count}** invite`;
  });
}

function buildLeaderboardEmbed(guildData, limit = 10, field = 'totalSeconds') {
  const lines = buildVoiceLeaderboardLines(guildData, limit, field);

  const title = field === 'activeSeconds'
    ? '🎙️ Leaderboard Voice Aktif (mic & deafen terbuka)'
    : '🏆 Leaderboard Voice Channel (total stay)';

  return new EmbedBuilder()
    .setColor(field === 'activeSeconds' ? 0x2ECC71 : 0xF1C40F)
    .setTitle(title)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Update terakhir` })
    .setTimestamp();
}

// Rekap gabungan: voice aktif + voice stay + invite, sekaligus dalam 1 pesan
function buildCombinedLeaderboardEmbed(guildData, limit = 5, guildName = '') {
  const activeLines = buildVoiceLeaderboardLines(guildData, limit, 'activeSeconds');
  const stayLines = buildVoiceLeaderboardLines(guildData, limit, 'totalSeconds');
  const inviteLines = buildInviteLeaderboardLines(guildData, limit);

  return new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle(`📊 Rekap Leaderboard ${guildName}`.trim())
    .addFields(
      { name: '🎙️ Voice Aktif (mic & deafen terbuka)', value: activeLines.join('\n') },
      { name: '🏆 Voice Channel (total stay)', value: stayLines.join('\n') },
      { name: '📨 Undangan Member', value: inviteLines.join('\n') },
    )
    .setFooter({ text: 'Update terakhir' })
    .setTimestamp();
}

async function postScheduledLeaderboard(guild) {
  const guildData = getGuildData(data, guild.id);
  if (!guildData.leaderboardChannelId) return;

  let channel;
  try {
    channel = await guild.channels.fetch(guildData.leaderboardChannelId);
  } catch (err) {
    console.error(`Channel leaderboard ${guildData.leaderboardChannelId} tidak ditemukan di guild ${guild.id}:`, err.message);
    return;
  }
  if (!channel || channel.type !== ChannelType.GuildText) return;

  // Hapus pesan leaderboard sebelumnya kalau ada
  if (guildData.lastLeaderboardMessageId) {
    try {
      const oldMessage = await channel.messages.fetch(guildData.lastLeaderboardMessageId);
      await oldMessage.delete();
    } catch (err) {
      // Pesan lama mungkin sudah dihapus manual / tidak ketemu, aman diabaikan
    }
  }

  const embed = buildCombinedLeaderboardEmbed(guildData, Math.min(guildData.leaderboardLimit || 5, 10), guild.name);
  try {
    const newMessage = await channel.send({ embeds: [embed] });
    guildData.lastLeaderboardMessageId = newMessage.id;
    saveData(data);
  } catch (err) {
    console.error(`Gagal mengirim leaderboard ke channel ${channel.id}:`, err.message);
  }
}

function scheduleLeaderboardPosts() {
  // Jam 06:00, 12:00, 18:00, dan 00:00 waktu Asia/Jakarta (WIB), setiap hari
  const jamPosting = ['0 6 * * *', '0 12 * * *', '0 18 * * *', '0 0 * * *'];
  for (const cronTime of jamPosting) {
    cron.schedule(cronTime, () => {
      for (const guild of client.guilds.cache.values()) {
        postScheduledLeaderboard(guild);
      }
    }, { timezone: 'Asia/Jakarta' });
  }
}

// Cek member yang UDAH ada di voice channel (join/aktif), mulai hitung sesi mereka.
// Dipanggil saat bot startup (semua guild) DAN saat bot baru gabung ke server baru (guildCreate).
async function reconcileVoiceStates(guild) {
  try {
    const channels = await guild.channels.fetch();
    for (const channel of channels.values()) {
      if (channel && channel.isVoiceBased && channel.isVoiceBased()) {
        for (const member of channel.members.values()) {
          if (!member.user.bot) {
            const guildData = getGuildData(data, guild.id);
            const userData = getUserData(guildData, member.id);
            // Kalau member ini sudah punya sesi berjalan (tersimpan di data.json),
            // JANGAN timpa sessionStart-nya -- biarkan tetap dari waktu dia mulai masuk voice,
            // supaya waktu yang sudah berjalan tidak hilang.
            if (!userData.sessionStart) {
              startSession(guild.id, member.id);
            }
            // Sama buat sesi "aktif" (mic & deafen terbuka) -- cek state sekarang
            const currentlyActive = isActiveVoiceState(member.voice);
            if (currentlyActive && !userData.activeSessionStart) {
              startActiveSession(guild.id, member.id);
            } else if (!currentlyActive && userData.activeSessionStart) {
              endActiveSession(guild.id, member.id);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`Gagal inisialisasi voice state untuk guild ${guild.id}:`, err.message);
  }
}

client.once('clientReady', async () => {
  console.log(`Bot aktif sebagai ${client.user.tag}`);

  // Kalau bot baru nyala/restart, mulai hitung ulang sesi untuk member yang sudah ada di voice channel
  for (const guild of client.guilds.cache.values()) {
    await reconcileVoiceStates(guild);
  }
  saveData(data);
  scheduleLeaderboardPosts();
  console.log('Jadwal auto-post leaderboard aktif (06:00, 12:00, 18:00 & 00:00 WIB).');

  // Cache invite yang ada sekarang di tiap guild, dipakai buat deteksi invite tracker
  for (const guild of client.guilds.cache.values()) {
    await cacheGuildInvites(guild);
  }
  console.log('Cache invite tracker siap.');
});

// Dipanggil setiap kali bot baru diundang/gabung ke server baru (tanpa perlu restart bot)
client.on('guildCreate', async (guild) => {
  console.log(`Bot baru gabung ke server: ${guild.name} (${guild.id})`);
  await reconcileVoiceStates(guild);
  await cacheGuildInvites(guild);
  saveData(data);
});

client.on('inviteCreate', (invite) => updateCacheOnCreate(invite));
client.on('inviteDelete', (invite) => updateCacheOnDelete(invite));

client.on('guildMemberAdd', async (member) => {
  if (member.user.bot) return;

  const guild = member.guild;
  const guildData = getGuildData(data, guild.id);
  const result = await findInviteUsed(guild);

  let inviterLabel;
  let inviterMention;

  if (result.inviterId) {
    guildData.invites[result.inviterId] = (guildData.invites[result.inviterId] || 0) + 1;
    guildData.joinedVia[member.id] = result.inviterId;
    inviterMention = `<@${result.inviterId}>`;
    inviterLabel = `${inviterMention} (total **${guildData.invites[result.inviterId]}** invite)`;
    await checkInviteAutoRole(guild, result.inviterId);
  } else if (result.vanity) {
    guildData.joinedVia[member.id] = 'vanity';
    inviterLabel = 'Vanity URL (tidak diketahui siapa yang undang)';
  } else {
    guildData.joinedVia[member.id] = 'unknown';
    inviterLabel = 'Tidak diketahui';
  }

  saveData(data);

  if (guildData.inviteChannelId) {
    try {
      const channel = await guild.channels.fetch(guildData.inviteChannelId);
      if (channel && channel.type === ChannelType.GuildText) {
        const embed = new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle('👋 Warga Baru')
          .setDescription(
            `**Warga Baru** : ${member}\n` +
            `**Diundang oleh** : ${inviterLabel}\n` +
            `**Total Member** : ${guild.memberCount}`
          );
        await channel.send({ embeds: [embed] });
      }
    } catch (err) {
      console.error(`Gagal kirim pesan welcome ke channel ${guildData.inviteChannelId}:`, err.message);
    }
  }
});

client.on('guildMemberRemove', async (member) => {
  if (member.user.bot) return;

  const guild = member.guild;
  const guildData = getGuildData(data, guild.id);
  const inviterId = guildData.joinedVia[member.id];

  delete guildData.joinedVia[member.id];

  // Cuma kurangi hitungan kalau member ini dulu masuk lewat invite orang yang jelas
  // (bukan vanity URL / tidak diketahui)
  if (inviterId && inviterId !== 'vanity' && inviterId !== 'unknown') {
    guildData.invites[inviterId] = Math.max((guildData.invites[inviterId] || 1) - 1, 0);
    saveData(data);
    await checkInviteAutoRole(guild, inviterId);

    if (guildData.inviteChannelId) {
      try {
        const channel = await guild.channels.fetch(guildData.inviteChannelId);
        if (channel && channel.type === ChannelType.GuildText) {
          const embed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle('👋 Warga Keluar')
            .setDescription(
              `**${member.user.tag}** keluar dari server.\n` +
              `Hitungan invite <@${inviterId}> dikurangi jadi **${guildData.invites[inviterId]}**.`
            );
          await channel.send({ embeds: [embed] });
        }
      } catch (err) {
        console.error(`Gagal kirim pesan keluar ke channel ${guildData.inviteChannelId}:`, err.message);
      }
    }
  } else {
    saveData(data);
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  const guildId = newState.guild.id;
  const wasInVoice = !!oldState.channelId;
  const isInVoice = !!newState.channelId;

  const wasActive = wasInVoice && isActiveVoiceState(oldState);
  const isActive = isInVoice && isActiveVoiceState(newState);

  if (!wasInVoice && isInVoice) {
    // Baru join voice channel
    startSession(guildId, member.id);
    if (isActive) startActiveSession(guildId, member.id);
    saveData(data);
  } else if (wasInVoice && !isInVoice) {
    // Keluar dari voice channel
    endSession(guildId, member.id);
    if (wasActive) endActiveSession(guildId, member.id);
    checkAutoRole(newState.guild, member);
    saveData(data);
  } else if (wasInVoice && isInVoice) {
    // Masih di voice (pindah channel, atau toggle mute/deafen) -- cek perubahan status aktif
    if (wasActive && !isActive) {
      endActiveSession(guildId, member.id);
      saveData(data);
    } else if (!wasActive && isActive) {
      startActiveSession(guildId, member.id);
      saveData(data);
    }
  }
});

const ADMIN_ONLY_COMMANDS = new Set([
  'setvoicerole',
  'removevoicerole',
  'listvoiceroles',
  'setleaderboardchannel',
  'disableleaderboardauto',
  'setinvitechannel',
  'setinvites',
  'setinviterole',
  'removeinviterole',
  'listinviteroles',
  'setachievementchannel',
  'settopvoicerole',
]);

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild } = interaction;

  // Kunci tambahan di level kode: meskipun setting command di Discord diubah manual
  // lewat Server Settings > Integrations, command ini tetap cuma bisa dipakai Administrator.
  if (ADMIN_ONLY_COMMANDS.has(commandName)) {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({
        content: '⛔ Command ini cuma bisa dipakai oleh member dengan izin **Administrator**.',
        ephemeral: true,
      });
      return;
    }
  }

  if (commandName === 'voicetime') {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const guildData = getGuildData(data, guild.id);
    const userData = getUserData(guildData, targetUser.id);

    let liveStaySeconds = userData.totalSeconds;
    if (userData.sessionStart) {
      liveStaySeconds += (Date.now() - userData.sessionStart) / 1000;
    }
    let liveActiveSeconds = userData.activeSeconds;
    if (userData.activeSessionStart) {
      liveActiveSeconds += (Date.now() - userData.activeSessionStart) / 1000;
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('⏱️ Waktu Voice Channel')
      .setDescription(
        `${targetUser}\n\n` +
        `**Total Stay** : ${formatDuration(liveStaySeconds)}\n` +
        `**Total Aktif** (mic & deafen terbuka) : ${formatDuration(liveActiveSeconds)}`
      );

    await interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'voiceleaderboard') {
    const limit = Math.min(interaction.options.getInteger('jumlah') || 10, 25);
    const guildData = getGuildData(data, guild.id);
    const embed = buildLeaderboardEmbed(guildData, limit, 'totalSeconds');
    await interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'voiceactiveleaderboard') {
    const limit = Math.min(interaction.options.getInteger('jumlah') || 10, 25);
    const guildData = getGuildData(data, guild.id);
    const embed = buildLeaderboardEmbed(guildData, limit, 'activeSeconds');
    await interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'leaderboardrekap') {
    const limit = Math.min(interaction.options.getInteger('jumlah') || 5, 10);
    const guildData = getGuildData(data, guild.id);
    const embed = buildCombinedLeaderboardEmbed(guildData, limit, guild.name);
    await interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'setvoicerole') {
    const role = interaction.options.getRole('role');
    const minutes = interaction.options.getInteger('menit');
    const guildData = getGuildData(data, guild.id);

    const existing = guildData.roles.find(r => r.roleId === role.id);
    if (existing) {
      existing.minutes = minutes;
    } else {
      guildData.roles.push({ roleId: role.id, minutes });
    }
    saveData(data);

    await interaction.reply(`✅ Member akan otomatis dapat role ${role} setelah **${minutes} menit** di voice channel.`);
  }

  if (commandName === 'removevoicerole') {
    const role = interaction.options.getRole('role');
    const guildData = getGuildData(data, guild.id);
    const before = guildData.roles.length;
    guildData.roles = guildData.roles.filter(r => r.roleId !== role.id);
    saveData(data);

    if (guildData.roles.length < before) {
      await interaction.reply(`✅ Aturan auto-role untuk ${role} sudah dihapus.`);
    } else {
      await interaction.reply(`Role ${role} tidak punya aturan auto-role yang aktif.`);
    }
  }

  if (commandName === 'listvoiceroles') {
    const guildData = getGuildData(data, guild.id);

    if (guildData.roles.length === 0) {
      await interaction.reply('Belum ada aturan auto-role voice yang diatur. Pakai /setvoicerole untuk menambahkan.');
      return;
    }

    const sorted = [...guildData.roles].sort((a, b) => a.minutes - b.minutes);
    const lines = sorted.map(r => `<@&${r.roleId}> — minimal **${r.minutes} menit**`);

    const embed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle('📋 Aturan Auto-Role Voice')
      .setDescription(lines.join('\n'));

    await interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'setinviterole') {
    const role = interaction.options.getRole('role');
    const jumlah = interaction.options.getInteger('jumlah');
    const guildData = getGuildData(data, guild.id);

    const existing = guildData.inviteRoles.find(r => r.roleId === role.id);
    if (existing) {
      existing.count = jumlah;
    } else {
      guildData.inviteRoles.push({ roleId: role.id, count: jumlah });
    }
    saveData(data);

    await interaction.reply(`✅ Member akan otomatis dapat role ${role} setelah mencapai **${jumlah} invite**.`);
  }

  if (commandName === 'removeinviterole') {
    const role = interaction.options.getRole('role');
    const guildData = getGuildData(data, guild.id);
    const before = guildData.inviteRoles.length;
    guildData.inviteRoles = guildData.inviteRoles.filter(r => r.roleId !== role.id);
    saveData(data);

    if (guildData.inviteRoles.length < before) {
      await interaction.reply(`✅ Aturan auto-role invite untuk ${role} sudah dihapus.`);
    } else {
      await interaction.reply(`Role ${role} tidak punya aturan auto-role invite yang aktif.`);
    }
  }

  if (commandName === 'listinviteroles') {
    const guildData = getGuildData(data, guild.id);

    if (!guildData.inviteRoles || guildData.inviteRoles.length === 0) {
      await interaction.reply('Belum ada aturan auto-role invite yang diatur. Pakai /setinviterole untuk menambahkan.');
      return;
    }

    const sorted = [...guildData.inviteRoles].sort((a, b) => a.count - b.count);
    const lines = sorted.map(r => `<@&${r.roleId}> — minimal **${r.count} invite**`);

    const embed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle('📋 Aturan Auto-Role Invite')
      .setDescription(lines.join('\n'));

    await interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'setleaderboardchannel') {
    const channel = interaction.options.getChannel('channel');
    const jumlah = interaction.options.getInteger('jumlah');
    if (channel.type !== ChannelType.GuildText) {
      await interaction.reply({ content: 'Pilih channel teks biasa ya, bukan voice channel atau kategori.', ephemeral: true });
      return;
    }

    const guildData = getGuildData(data, guild.id);
    guildData.leaderboardChannelId = channel.id;
    guildData.lastLeaderboardMessageId = null; // reset supaya tidak coba hapus pesan lama dari channel berbeda
    if (jumlah) {
      guildData.leaderboardLimit = Math.min(Math.max(jumlah, 1), 25);
    }
    saveData(data);

    await interaction.reply(`✅ Leaderboard akan otomatis diposting ke ${channel} setiap jam **06:00**, **12:00**, **18:00**, dan **00:00 WIB**, menampilkan **${guildData.leaderboardLimit}** user teratas. Pesan lama akan otomatis terhapus tiap kali post baru.`);
  }

  if (commandName === 'disableleaderboardauto') {
    const guildData = getGuildData(data, guild.id);
    guildData.leaderboardChannelId = null;
    guildData.lastLeaderboardMessageId = null;
    saveData(data);

    await interaction.reply('✅ Auto-post leaderboard terjadwal sudah dimatikan.');
  }

  if (commandName === 'invites') {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const guildData = getGuildData(data, guild.id);
    const count = guildData.invites[targetUser.id] || 0;

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📨 Total Invite')
      .setDescription(`${targetUser} sudah mengundang **${count}** warga ke server ini.`);

    await interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'inviteleaderboard') {
    const limit = Math.min(interaction.options.getInteger('jumlah') || 10, 25);
    const guildData = getGuildData(data, guild.id);

    const entries = Object.entries(guildData.invites)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    if (entries.length === 0) {
      await interaction.reply('Belum ada data invite di server ini.');
      return;
    }

    const lines = entries.map(([userId, count], i) => {
      const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
      return `${medal} <@${userId}> — **${count}** invite`;
    });

    const embed = new EmbedBuilder()
      .setColor(0xF1C40F)
      .setTitle('🏆 Leaderboard Invite')
      .setDescription(lines.join('\n'));

    await interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'setinvitechannel') {
    const channel = interaction.options.getChannel('channel');
    if (channel.type !== ChannelType.GuildText) {
      await interaction.reply({ content: 'Pilih channel teks biasa ya, bukan voice channel atau kategori.', ephemeral: true });
      return;
    }

    const guildData = getGuildData(data, guild.id);
    guildData.inviteChannelId = channel.id;
    saveData(data);

    await interaction.reply(`✅ Pesan warga baru & warga keluar akan otomatis dikirim ke ${channel}.`);
  }

  if (commandName === 'setinvites') {
    const targetUser = interaction.options.getUser('user');
    const jumlah = interaction.options.getInteger('jumlah');

    const guildData = getGuildData(data, guild.id);
    guildData.invites[targetUser.id] = Math.max(jumlah, 0);
    saveData(data);
    await checkInviteAutoRole(guild, targetUser.id);

    await interaction.reply(`✅ Total invite ${targetUser} sekarang diset ke **${guildData.invites[targetUser.id]}**.`);
  }

  if (commandName === 'setachievementchannel') {
    const channel = interaction.options.getChannel('channel');
    if (channel.type !== ChannelType.GuildText) {
      await interaction.reply({ content: 'Pilih channel teks biasa ya, bukan voice channel atau kategori.', ephemeral: true });
      return;
    }

    const guildData = getGuildData(data, guild.id);
    guildData.achievementChannelId = channel.id;
    saveData(data);

    await interaction.reply(`✅ Pengumuman kenaikan role (invite tier & top voice) akan dikirim ke ${channel}.`);
  }

  if (commandName === 'settopvoicerole') {
    const tipe = interaction.options.getString('tipe');
    const peringkat = interaction.options.getInteger('peringkat');
    const role = interaction.options.getRole('role');
    const guildData = getGuildData(data, guild.id);

    const ranksKey = tipe === 'stay' ? 'topVoiceStayRanks' : 'topVoiceActiveRanks';
    guildData[ranksKey][peringkat - 1].roleId = role.id;
    guildData[ranksKey][peringkat - 1].holder = null; // reset supaya dihitung ulang dari 0
    saveData(data);

    await checkTopVoiceRoles(guild);

    const label = tipe === 'stay' ? 'Voice Stay' : 'Voice Aktif';
    await interaction.reply(`✅ Role ${role} sekarang jadi role **Peringkat ${peringkat} ${label}** — otomatis pindah tiap kali ada yang menyusul.`);
  }
});

client.on('error', (err) => console.error('Client error:', err));

process.on('SIGINT', () => { saveData(data); process.exit(0); });
process.on('SIGTERM', () => { saveData(data); process.exit(0); });

client.login(process.env.DISCORD_TOKEN).then(() => {
  // Jalanin API internal SETELAH bot berhasil login, biar client.guilds.cache sudah terisi.
  // Kalau DASHBOARD_API_SECRET tidak diset, API ini nggak dijalankan sama sekali (aman by default).
  if (process.env.DASHBOARD_API_SECRET) {
    startInternalApi({
      client,
      data,
      port: process.env.API_PORT || 4000,
      apiSecret: process.env.DASHBOARD_API_SECRET,
      checkTopVoiceRoles,
      checkInviteAutoRole,
    });
  } else {
    console.log('DASHBOARD_API_SECRET belum diset -- API internal untuk dashboard tidak dijalankan.');
  }
});
