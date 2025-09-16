// index.js
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType
} = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is required');
  process.exit(1);
}

// --- Express ---
const app = express();
app.use(express.json());

app.post('/interactions', (req, res) => {
  res.json({ type: 1 });
});
app.get('/', (req, res) => res.send('OK - office tracker'));
const PORT = process.env.PORT || 10000;

// --- Postgres ---
const poolConfig = {
  connectionString: process.env.DATABASE_URL || null,
  max: process.env.PG_MAX ? Number(process.env.PG_MAX) : 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000
};
if (process.env.DATABASE_SSL === 'true') {
  poolConfig.ssl = { rejectUnauthorized: false };
}
const pool = new Pool(poolConfig);

// --- Discord client ---
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- DB initialization ---
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS active_users (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      start BIGINT,
      planned_start BIGINT,
      expected_end BIGINT,
      note TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS panel (
      channel_id TEXT PRIMARY KEY,
      message_id TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS history (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      username TEXT,
      start BIGINT,
      ended_at BIGINT,
      note TEXT
    );
  `);
  console.log('DB initialized');
}

// --- Helpers ---
function fmtTs(ts) {
  if (!ts) return '未設定';
  const d = new Date(Number(ts) * 1000);
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${jst.getFullYear()}/${(jst.getMonth()+1).toString().padStart(2,'0')}/${jst.getDate().toString().padStart(2,'0')} ${jst.getHours().toString().padStart(2,'0')}:${jst.getMinutes().toString().padStart(2,'0')}`;
}
function fmtHHMM(ts) {
  if (!ts) return '未設定';
  const d = new Date(Number(ts) * 1000);
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${jst.getHours().toString().padStart(2,'0')}:${jst.getMinutes().toString().padStart(2,'0')}`;
}

function panelComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('office_join').setLabel('利用します').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('office_leave').setLabel('退出します').setStyle(ButtonStyle.Danger)
  );
  return [row];
}

// Embed生成
async function buildPanelEmbed(channelId) {
  const res = await pool.query('SELECT user_id, username, start, planned_start, expected_end, note FROM active_users ORDER BY start');
  const rows = res.rows || [];
  let desc = '';
  const now = Math.floor(Date.now() / 1000);

  if (rows.length === 0) desc = '現在、事務所にいる人はいません。';
  else {
    for (const r of rows) {
      let statusIcon = '🟢';
      let startDisplay = fmtTs(r.start);

      if (r.planned_start && r.planned_start > now) {
        statusIcon = '🟡';
        startDisplay = fmtTs(r.planned_start);
      }

      desc += `${statusIcon} ${r.username} — 開始: ${startDisplay} / 終了予定: ${r.expected_end ? fmtHHMM(r.expected_end) : '未設定'} ${r.note ? `📝${r.note}` : ''}\n`;
    }
  }

  return new EmbedBuilder()
    .setTitle('📌 事務所 利用状況（現在）')
    .setDescription(desc)
    .setFooter({ text: '「利用します」を押して登録／退出時は「退出します」を押してください。' })
    .setTimestamp();
}

async function updatePanel(channelId) {
  try {
    const rr = await pool.query('SELECT message_id FROM panel WHERE channel_id = $1', [channelId]);
    if (!rr.rows.length) return;
    const messageId = rr.rows[0].message_id;
    const channel = await client.channels.fetch(channelId);
    if (!channel) return;
    const message = await channel.messages.fetch(messageId);
    if (!message) return;
    await message.edit({ embeds: [await buildPanelEmbed(channelId)], components: panelComponents() });
  } catch (err) {
    console.error('updatePanel error:', err);
  }
}

async function sendLog(message) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (logChannel) await logChannel.send(message);
  } catch (err) {
    console.error('sendLog error:', err);
  }
}

// --- Discord Interaction handling ---
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'setup-office') {
        const embed = await buildPanelEmbed(interaction.channelId);
        const sent = await interaction.channel.send({ embeds: [embed], components: panelComponents() });
        await pool.query(
          'INSERT INTO panel(channel_id, message_id) VALUES($1,$2) ON CONFLICT (channel_id) DO UPDATE SET message_id = EXCLUDED.message_id',
          [interaction.channelId, sent.id]
        );
        await interaction.reply({ content: '事務所パネルを設置しました。', ephemeral: true });
        return;
      }
      if (interaction.commandName === 'remove-office') {
        await pool.query('DELETE FROM panel WHERE channel_id = $1', [interaction.channelId]);
        await interaction.reply({ content: 'このチャンネルの事務所パネル情報を削除しました。', ephemeral: true });
        return;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'office_join') {
        const modal = new ModalBuilder()
          .setCustomId('office_join_modal')
          .setTitle('事務所利用登録');

        const startInput = new TextInputBuilder()
          .setCustomId('startTime')
          .setLabel('利用開始予定時刻（例: 09:00, 空欄=すぐ開始）')
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        const endInput = new TextInputBuilder()
          .setCustomId('endTime')
          .setLabel('終了予定時刻（例: 18:00）')
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        const noteInput = new TextInputBuilder()
          .setCustomId('note')
          .setLabel('用途やメモ（任意）')
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        modal.addComponents(
          new ActionRowBuilder().addComponents(startInput),
          new ActionRowBuilder().addComponents(endInput),
          new ActionRowBuilder().addComponents(noteInput)
        );

        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === 'office_leave') {
        const r = await pool.query('SELECT * FROM active_users WHERE user_id = $1', [interaction.user.id]);
        if (!r.rows.length) {
          await interaction.deferUpdate();
          return;
        }
        const get = r.rows[0];
        const now = Math.floor(Date.now() / 1000);

        await pool.query(
          'INSERT INTO history(user_id, username, start, ended_at, note) VALUES($1,$2,$3,$4,$5)',
          [get.user_id, get.username, get.start, now, get.note]
        );
        await pool.query('DELETE FROM active_users WHERE user_id = $1', [interaction.user.id]);
        await interaction.deferUpdate();

        await sendLog(`🟥 ${interaction.member?.displayName || interaction.user.username} が退出しました（開始: ${fmtTs(get.start)} → 退出: ${fmtTs(now)}）。${get.note ? ` 📝: ${get.note}` : ''}`);

        const panels = await pool.query('SELECT channel_id FROM panel');
        for (const p of panels.rows) await updatePanel(p.channel_id);
        return;
      }
    }

    if (interaction.type === InteractionType.ModalSubmit && interaction.customId === 'office_join_modal') {
      const startTimeText = interaction.fields.getTextInputValue('startTime') || '';
      const endTimeText = interaction.fields.getTextInputValue('endTime') || '';
      const note = interaction.fields.getTextInputValue('note') || '';

      const now = new Date();
      const jstNow = new Date(now.getTime() + 9 * 3600 * 1000);

      let plannedStart = null;
      let startTs = Math.floor(Date.now() / 1000);

      if (startTimeText) {
        const m = startTimeText.match(/^(\d{1,2}):(\d{2})$/);
        if (m) {
          const hh = parseInt(m[1], 10);
          const mm = parseInt(m[2], 10);
          const sJST = new Date(Date.UTC(
            jstNow.getUTCFullYear(),
            jstNow.getUTCMonth(),
            jstNow.getUTCDate(),
            hh,
            mm,
            0
          ));
          if (sJST.getTime() <= jstNow.getTime()) sJST.setUTCDate(sJST.getUTCDate() + 1);
          plannedStart = Math.floor(sJST.getTime() / 1000 - 9 * 3600);
          startTs = plannedStart;
        }
      }

      let expectedEnd = null;
      if (endTimeText) {
        const m = endTimeText.match(/^(\d{1,2}):(\d{2})$/);
        if (m) {
          const hh = parseInt(m[1], 10);
          const mm = parseInt(m[2], 10);
          const eJST = new Date(Date.UTC(
            jstNow.getUTCFullYear(),
            jstNow.getUTCMonth(),
            jstNow.getUTCDate(),
            hh,
            mm,
            0
          ));
          if (eJST.getTime() <= jstNow.getTime()) eJST.setUTCDate(eJST.getUTCDate() + 1);
          expectedEnd = Math.floor(eJST.getTime() / 1000 - 9 * 3600);
        }
      }

      const username = interaction.member?.displayName || interaction.user.username;

      await pool.query(
        'INSERT INTO active_users(user_id, username, start, planned_start, expected_end, note) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id) DO UPDATE SET username=$2, start=$3, planned_start=$4, expected_end=$5, note=$6',
        [interaction.user.id, username, startTs, plannedStart, expectedEnd, note]
      );

      await sendLog(`🟩 ${username} が利用を登録しました（${plannedStart ? `開始予定: ${fmtHHMM(plannedStart)}` : `開始: ${fmtTs(startTs)}`} ${expectedEnd ? `→ 終了予定: ${fmtHHMM(expectedEnd)}` : ''}）。${note ? ` 📝: ${note}` : ''}`);

      const panels = await pool.query('SELECT channel_id FROM panel');
      for (const p of panels.rows) await updatePanel(p.channel_id);

      await interaction.deferUpdate();
    }
  } catch (err) {
    console.error('interaction error:', err);
    try { if (interaction && !interaction.replied) await interaction.deferUpdate(); } catch {}
  }
});

// --- 自動チェック ---
setInterval(async () => {
  try {
    const now = Math.floor(Date.now() / 1000);

    // 開始予定時刻を過ぎた人を利用中に切り替え（🟡→🟢）
    const pending = await pool.query('SELECT user_id, username, planned_start FROM active_users WHERE planned_start IS NOT NULL AND planned_start <= $1', [now]);
    for (const r of pending.rows) {
      await pool.query('UPDATE active_users SET planned_start = NULL WHERE user_id = $1', [r.user_id]);
      await sendLog(`▶️ ${r.username} が利用を開始しました（予定時刻 ${fmtHHMM(r.planned_start)} 到達）。`);
    }

    // 終了予定を過ぎた人を削除
    const expired = await pool.query('SELECT user_id, username, start, expected_end, note FROM active_users WHERE expected_end IS NOT NULL AND expected_end <= $1', [now]);
    for (const r of expired.rows) {
      await pool.query(
        'INSERT INTO history(user_id, username, start, ended_at, note) VALUES($1,$2,$3,$4,$5)',
        [r.user_id, r.username, r.start, r.expected_end, r.note]
      );
      await pool.query('DELETE FROM active_users WHERE user_id = $1', [r.user_id]);
      await sendLog(`⏰ ${r.username} の利用時間が終了しました（開始: ${fmtTs(r.start)} → 自動終了: ${fmtHHMM(r.expected_end)}）。${r.note ? ` 📝: ${r.note}` : ''}`);
    }

    const panels = await pool.query('SELECT channel_id FROM panel');
    for (const p of panels.rows) await updatePanel(p.channel_id);
  } catch (err) {
    console.error('auto-check error:', err);
  }
}, 60 * 1000);

// --- Start ---
(async () => {
  try {
    await initDb();
    app.listen(PORT, '0.0.0.0', () => console.log(`HTTP server listening on ${PORT}`));
    await client.login(DISCORD_TOKEN);
    console.log('Discord client logged in');
  } catch (err) {
    console.error('startup error', err);
    process.exit(1);
  }
})();






// // index.js
// require('dotenv').config();
// const express = require('express');
// const { Pool } = require('pg');
// const {
//   Client,
//   GatewayIntentBits,
//   ActionRowBuilder,
//   ButtonBuilder,
//   ButtonStyle,
//   EmbedBuilder,
//   ModalBuilder,
//   TextInputBuilder,
//   TextInputStyle,
//   InteractionType
// } = require('discord.js');

// const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
// const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

// if (!DISCORD_TOKEN) {
//   console.error('DISCORD_TOKEN is required');
//   process.exit(1);
// }

// // --- Express ---
// const app = express();
// app.use(express.json());

// // Ping 用エンドポイント（Discord Interaction）
// // ここは Render 側で必須、署名検証は省略しています
// app.post('/interactions', (req, res) => {
//   res.json({ type: 1 }); // PONG
// });

// app.get('/', (req, res) => res.send('OK - office tracker'));
// const PORT = process.env.PORT || 10000;

// // --- Postgres ---
// const poolConfig = {
//   connectionString: process.env.DATABASE_URL || null,
//   max: process.env.PG_MAX ? Number(process.env.PG_MAX) : 5,
//   idleTimeoutMillis: 30000,
//   connectionTimeoutMillis: 20000
// };
// if (process.env.DATABASE_SSL === 'true') {
//   poolConfig.ssl = { rejectUnauthorized: false };
// }
// const pool = new Pool(poolConfig);

// // --- Discord client ---
// const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// // --- DB initialization ---
// async function initDb() {
//   await pool.query(`
//     CREATE TABLE IF NOT EXISTS active_users (
//       user_id TEXT PRIMARY KEY,
//       username TEXT,
//       start BIGINT,
//       expected_end BIGINT,
//       note TEXT
//     );
//   `);
//   await pool.query(`
//     CREATE TABLE IF NOT EXISTS panel (
//       channel_id TEXT PRIMARY KEY,
//       message_id TEXT
//     );
//   `);
//   await pool.query(`
//     CREATE TABLE IF NOT EXISTS history (
//       id SERIAL PRIMARY KEY,
//       user_id TEXT,
//       username TEXT,
//       start BIGINT,
//       ended_at BIGINT,
//       note TEXT
//     );
//   `);
//   console.log('DB initialized');
// }

// // --- Helpers ---
// function fmtTs(ts) {
//   if (!ts) return '未設定';
//   const d = new Date(Number(ts) * 1000);
//   const jst = new Date(d.getTime() + 9 * 3600 * 1000); // JST
//   return `${jst.getFullYear()}/${(jst.getMonth()+1).toString().padStart(2,'0')}/${jst.getDate().toString().padStart(2,'0')} ${jst.getHours().toString().padStart(2,'0')}:${jst.getMinutes().toString().padStart(2,'0')}`;
// }

// function fmtHHMM(ts) {
//   if (!ts) return '未設定';
//   const d = new Date(Number(ts) * 1000);
//   const jst = new Date(d.getTime() + 9 * 3600 * 1000);
//   return `${jst.getHours().toString().padStart(2,'0')}:${jst.getMinutes().toString().padStart(2,'0')}`;
// }

// function panelComponents() {
//   const row = new ActionRowBuilder().addComponents(
//     new ButtonBuilder().setCustomId('office_join').setLabel('利用します').setStyle(ButtonStyle.Success),
//     new ButtonBuilder().setCustomId('office_leave').setLabel('退出します').setStyle(ButtonStyle.Danger)
//   );
//   return [row];
// }

// async function buildPanelEmbed(channelId) {
//   const res = await pool.query('SELECT user_id, username, start, expected_end, note FROM active_users ORDER BY start');
//   const rows = res.rows || [];
//   let desc = '';
//   if (rows.length === 0) desc = '現在、事務所にいる人はいません。';
//   else {
//     for (const r of rows) {
//       desc += `🟢 ${r.username} — 開始: ${fmtTs(r.start)} / 終了予定: ${r.expected_end ? fmtHHMM(r.expected_end) : '未設定'} ${r.note ? `📝${r.note}` : ''}\n`;
//     }
//   }
//   return new EmbedBuilder()
//     .setTitle('📌 事務所 利用状況（現在）')
//     .setDescription(desc)
//     .setFooter({ text: '「利用します」を押して登録／退出時は「退出します」を押してください。' })
//     .setTimestamp();
// }

// async function updatePanel(channelId) {
//   try {
//     const rr = await pool.query('SELECT message_id FROM panel WHERE channel_id = $1', [channelId]);
//     if (!rr.rows.length) return;
//     const messageId = rr.rows[0].message_id;
//     const channel = await client.channels.fetch(channelId);
//     if (!channel) return;
//     const message = await channel.messages.fetch(messageId);
//     if (!message) return;
//     await message.edit({ embeds: [await buildPanelEmbed(channelId)], components: panelComponents() });
//   } catch (err) {
//     console.error('updatePanel error:', err);
//   }
// }

// async function sendLog(message) {
//   if (!LOG_CHANNEL_ID) return;
//   try {
//     const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
//     if (logChannel) await logChannel.send(message);
//   } catch (err) {
//     console.error('sendLog error:', err);
//   }
// }

// // --- Discord Interaction handling ---
// client.on('interactionCreate', async (interaction) => {
//   try {
//     // スラッシュコマンド
//     if (interaction.isChatInputCommand()) {
//       const cmd = interaction.commandName;
//       if (cmd === 'setup-office') {
//         const embed = await buildPanelEmbed(interaction.channelId);
//         const sent = await interaction.channel.send({ embeds: [embed], components: panelComponents() });
//         await pool.query(
//           'INSERT INTO panel(channel_id, message_id) VALUES($1,$2) ON CONFLICT (channel_id) DO UPDATE SET message_id = EXCLUDED.message_id',
//           [interaction.channelId, sent.id]
//         );
//         await interaction.deferReply({ ephemeral: true });
//         await interaction.editReply('事務所パネルを設置しました。');
//         return;
//       }
//       if (cmd === 'remove-office') {
//         await pool.query('DELETE FROM panel WHERE channel_id = $1', [interaction.channelId]);
//         await interaction.deferReply({ ephemeral: true });
//         await interaction.editReply('このチャンネルの事務所パネル情報を削除しました（メッセージ自体は残ります）。');
//         return;
//       }
//     }

//     // ボタン処理
//     if (interaction.isButton()) {
//       if (interaction.customId === 'office_join') {
//         const modal = new ModalBuilder()
//           .setCustomId('office_join_modal')
//           .setTitle('事務所利用登録');

//         const endTimeInput = new TextInputBuilder()
//           .setCustomId('endTime')
//           .setLabel('終了予定時刻（例: 09:00, 13:30）')
//           .setStyle(TextInputStyle.Short)
//           .setRequired(false);

//         const noteInput = new TextInputBuilder()
//           .setCustomId('note')
//           .setLabel('用途やメモ（任意）')
//           .setStyle(TextInputStyle.Short)
//           .setRequired(false);

//         modal.addComponents(new ActionRowBuilder().addComponents(endTimeInput));
//         modal.addComponents(new ActionRowBuilder().addComponents(noteInput));

//         await interaction.showModal(modal);
//         return;
//       }

//       if (interaction.customId === 'office_leave') {
//         const r = await pool.query('SELECT * FROM active_users WHERE user_id = $1', [interaction.user.id]);
//         if (!r.rows.length) {
//           await interaction.deferUpdate();
//           return;
//         }
//         const get = r.rows[0];
//         const now = Math.floor(Date.now() / 1000);
//         await pool.query(
//           'INSERT INTO history(user_id, username, start, ended_at, note) VALUES($1,$2,$3,$4,$5)',
//           [get.user_id, get.username, get.start, now, get.note]
//         );
//         await pool.query('DELETE FROM active_users WHERE user_id = $1', [interaction.user.id]);
//         await interaction.deferUpdate();

//         await sendLog(`🟥 ${interaction.member?.displayName || interaction.user.username} が退出しました（開始: ${fmtTs(get.start)} → 退出: ${fmtTs(now)}）。${get.note ? ` 📝: ${get.note}` : ''}`);

//         const panels = await pool.query('SELECT channel_id FROM panel');
//         for (const p of panels.rows) await updatePanel(p.channel_id);
//         return;
//       }
//     }

//     // モーダル送信
//     if (interaction.type === InteractionType.ModalSubmit && interaction.customId === 'office_join_modal') {
//       const endTimeText = interaction.fields.getTextInputValue('endTime') || '';
//       const note = interaction.fields.getTextInputValue('note') || '';
//       let expectedEnd = null;

//       if (endTimeText) {
//         const m = endTimeText.match(/^(\d{1,2}):(\d{2})$/);
//         if (m) {
//           const hh = parseInt(m[1], 10);
//           const mm = parseInt(m[2], 10);

//           // JST 時間処理
//           const now = new Date();
//           const jstNow = new Date(now.getTime() + 9 * 3600 * 1000);
//           const endJST = new Date(Date.UTC(
//             jstNow.getUTCFullYear(),
//             jstNow.getUTCMonth(),
//             jstNow.getUTCDate(),
//             hh,
//             mm,
//             0
//           ));
//           if (endJST.getTime() <= jstNow.getTime()) endJST.setUTCDate(endJST.getUTCDate() + 1);
//           expectedEnd = Math.floor(endJST.getTime() / 1000 - 9 * 3600);
//         }
//       }

//       const nowTs = Math.floor(Date.now() / 1000);
//       const username = interaction.member?.displayName || interaction.user.username;

//       await pool.query(
//         'INSERT INTO active_users(user_id, username, start, expected_end, note) VALUES($1,$2,$3,$4,$5)',
//         [interaction.user.id, username, nowTs, expectedEnd, note]
//       );

//       await sendLog(`🟩 ${username} が利用を開始しました（開始: ${fmtTs(nowTs)}${expectedEnd ? ` → 終了予定: ${fmtHHMM(expectedEnd)}` : ''}）。${note ? ` 📝: ${note}` : ''}`);

//       const panels = await pool.query('SELECT channel_id FROM panel');
//       for (const p of panels.rows) await updatePanel(p.channel_id);

//       await interaction.deferUpdate();
//     }

//   } catch (err) {
//     console.error('interaction error:', err);
//     try { if (interaction && !interaction.replied) await interaction.deferUpdate(); } catch {}
//   }
// });

// // --- 自動終了チェック（1分ごと） ---
// setInterval(async () => {
//   try {
//     const now = Math.floor(Date.now() / 1000);
//     const rr = await pool.query('SELECT user_id, username, start, expected_end, note FROM active_users WHERE expected_end IS NOT NULL AND expected_end <= $1', [now]);
//     for (const r of rr.rows) {
//       await pool.query(
//         'INSERT INTO history(user_id, username, start, ended_at, note) VALUES($1,$2,$3,$4,$5)',
//         [r.user_id, r.username, r.start, r.expected_end, r.note]
//       );
//       await pool.query('DELETE FROM active_users WHERE user_id = $1', [r.user_id]);

//       await sendLog(`⏰ ${r.username} の利用時間が終了しました（開始: ${fmtTs(r.start)} → 自動終了: ${fmtHHMM(r.expected_end)}）。${r.note ? ` 📝: ${r.note}` : ''}`);
//     }
//     const panels = await pool.query('SELECT channel_id FROM panel');
//     for (const p of panels.rows) await updatePanel(p.channel_id);
//   } catch (err) {
//     console.error('auto-expire error:', err);
//   }
// }, 60 * 1000);

// // --- Start up ---
// (async () => {
//   try {
//     await initDb();
//     app.listen(PORT, '0.0.0.0', () => console.log(`HTTP server listening on ${PORT}`));
//     await client.login(DISCORD_TOKEN);
//     console.log('Discord client logged in');
//   } catch (err) {
//     console.error('startup error', err);
//     process.exit(1);
//   }
// })();

