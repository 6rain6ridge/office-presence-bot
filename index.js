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
  TextInputStyle
} = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID; // 履歴ログ用チャンネル

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is required');
  process.exit(1);
}

// --- Express for Render health check (must bind PORT) ---
const app = express();
app.get('/', (req, res) => res.send('OK - office tracker'));
const PORT = process.env.PORT || 10000;

// --- Postgres (Neon) pool configuration ---
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
  return `${d.getFullYear()}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getDate().toString().padStart(2,'0')} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
}
function panelComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('office_join').setLabel('利用します').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('office_leave').setLabel('退出します').setStyle(ButtonStyle.Danger)
  );
  return [row];
}
async function buildPanelEmbed(channelId) {
  const res = await pool.query('SELECT user_id, username, start, expected_end, note FROM active_users ORDER BY start');
  const rows = res.rows || [];
  let desc = '';
  if (rows.length === 0) desc = '現在、事務所にいる人はいません。';
  else {
    for (const r of rows) {
      desc += `• <@${r.user_id}> — 開始: ${fmtTs(r.start)} / 終了予定: ${r.expected_end ? fmtTs(r.expected_end) : '未設定'} ${r.note ? `／${r.note}` : ''}\n`;
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

// --- Send log to history channel ---
async function sendLog(message) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (logChannel) await logChannel.send(message);
  } catch (err) {
    console.error('sendLog error:', err);
  }
}

// --- Interaction handling (buttons, modal, commands) ---
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;
      if (cmd === 'setup-office') {
        const embed = await buildPanelEmbed(interaction.channelId);
        const sent = await interaction.channel.send({ embeds: [embed], components: panelComponents() });
        await pool.query('INSERT INTO panel(channel_id, message_id) VALUES($1,$2) ON CONFLICT (channel_id) DO UPDATE SET message_id = EXCLUDED.message_id', [interaction.channelId, sent.id]);
        await interaction.reply({ content: '事務所パネルを設置しました。', ephemeral: true });
        return;
      }
      if (cmd === 'remove-office') {
        await pool.query('DELETE FROM panel WHERE channel_id = $1', [interaction.channelId]);
        await interaction.reply({ content: 'このチャンネルの事務所パネル情報を削除しました（メッセージ自体は残ります）。', ephemeral: true });
        return;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'office_join') {
        const modal = new ModalBuilder().setCustomId('office_join_modal').setTitle('事務所利用登録');
        const endInput = new TextInputBuilder().setCustomId('endTime').setLabel('予定終了時刻（任意、HH:MM）').setStyle(TextInputStyle.Short).setRequired(false);
        const noteInput = new TextInputBuilder().setCustomId('note').setLabel('用途やメモ（任意）').setStyle(TextInputStyle.Short).setRequired(false);
        modal.addComponents(new ActionRowBuilder().addComponents(endInput), new ActionRowBuilder().addComponents(noteInput));
        await interaction.showModal(modal);
        return;
      }
      if (interaction.customId === 'office_leave') {
        const r = await pool.query('SELECT * FROM active_users WHERE user_id = $1', [interaction.user.id]);
        if (!r.rows.length) {
          await interaction.reply({ content: 'あなたは現在登録されていません。', ephemeral: true });
          return;
        }
        const get = r.rows[0];
        const now = Math.floor(Date.now() / 1000);
        await pool.query('INSERT INTO history(user_id, username, start, ended_at, note) VALUES($1,$2,$3,$4,$5)',[get.user_id, get.username, get.start, now, get.note]);
        await pool.query('DELETE FROM active_users WHERE user_id = $1', [interaction.user.id]);
        await interaction.deferUpdate();

        // 履歴チャンネルに送信
        await sendLog(`🟥 ${interaction.user.username} が退出しました（開始: ${fmtTs(get.start)} → 退出: ${fmtTs(now)}）。${get.note ? ` メモ: ${get.note}` : ''}`);

        const panels = await pool.query('SELECT channel_id FROM panel');
        for (const p of panels.rows) await updatePanel(p.channel_id);
        return;
      }
    }

    if (interaction.isModalSubmit && interaction.customId === 'office_join_modal') {
      const exists = await pool.query('SELECT user_id FROM active_users WHERE user_id = $1', [interaction.user.id]);
      if (exists.rows.length) {
        await interaction.reply({ content: '既に事務所利用中として登録されています。退出する場合は「退出します」を押してください。', ephemeral: true });
        return;
      }
      const endText = interaction.fields.getTextInputValue('endTime') || '';
      const note = interaction.fields.getTextInputValue('note') || '';
      let expectedEnd = null;
      if (endText.trim()) {
        const m = endText.trim().match(/^(\d{1,2}):(\d{2})$/);
        if (m) {
          const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
          const now = new Date();
          const endDate = new Date(now);
          endDate.setHours(hh, mm, 0, 0);
          if (endDate.getTime() <= now.getTime()) endDate.setDate(endDate.getDate() + 1);
          expectedEnd = Math.floor(endDate.getTime() / 1000);
        } else {
          await interaction.reply({ content: '予定終了時刻は HH:MM 形式で指定してください。無効な形式なので予定終了は未設定で登録します。', ephemeral: true });
        }
      }
      const nowTs = Math.floor(Date.now() / 1000);
      const username = `${interaction.user.username}#${interaction.user.discriminator}`;
      await pool.query('INSERT INTO active_users(user_id, username, start, expected_end, note) VALUES($1,$2,$3,$4,$5)', [interaction.user.id, username, nowTs, expectedEnd, note]);
      await interaction.deferUpdate();

      // 履歴チャンネルに送信
      await sendLog(`🟩 ${interaction.user.username} が利用を開始しました（開始: ${fmtTs(nowTs)}${expectedEnd ? ` → 終了予定: ${fmtTs(expectedEnd)}` : ''}）。${note ? ` メモ: ${note}` : ''}`);

      const panels = await pool.query('SELECT channel_id FROM panel');
      for (const p of panels.rows) await updatePanel(p.channel_id);
    }
  } catch (err) {
    console.error('interaction error:', err);
    try { if (interaction && !interaction.replied) await interaction.reply({ content: '内部エラーが発生しました。', ephemeral: true }); } catch {}
  }
});

// --- auto-expire scheduled check every minute ---
setInterval(async () => {
  try {
    const now = Math.floor(Date.now() / 1000);
    const rr = await pool.query('SELECT user_id, username, start, expected_end, note FROM active_users WHERE expected_end IS NOT NULL AND expected_end <= $1', [now]);
    for (const r of rr.rows) {
      await pool.query('INSERT INTO history(user_id, username, start, ended_at, note) VALUES($1,$2,$3,$4,$5)',[r.user_id, r.username, r.start, r.expected_end, r.note]);
      await pool.query('DELETE FROM active_users WHERE user_id = $1', [r.user_id]);

      // 履歴チャンネルに送信
      await sendLog(`⏰ ${r.username} の利用時間が終了しました（開始: ${fmtTs(r.start)} → 自動終了: ${fmtTs(r.expected_end)}）。${r.note ? ` メモ: ${r.note}` : ''}`);
    }
    const panels = await pool.query('SELECT channel_id FROM panel');
    for (const p of panels.rows) await updatePanel(p.channel_id);
  } catch (err) {
    console.error('auto-expire error:', err);
  }
}, 60 * 1000);

// --- start up ---
(async () => {
  try {
    if (!process.env.DATABASE_URL) console.warn('DATABASE_URL not set — DB operations will fail until you set it.');
    await initDb();
    app.listen(PORT, '0.0.0.0', () => console.log(`HTTP server listening on ${PORT}`));
    await client.login(DISCORD_TOKEN);
    console.log('Discord client logged in');
  } catch (err) {
    console.error('startup error', err);
    process.exit(1);
  }
})();
