import express from "express";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
} from "discord.js";

// ====== 環境変数 ======
const TOKEN = process.env.DISCORD_TOKEN;   // Botトークン
const CLIENT_ID = process.env.CLIENT_ID;   // アプリID
const GUILD_ID = process.env.GUILD_ID;     // サーバーID（開発用のギルドコマンド）
const CHANNEL_ID = process.env.CHANNEL_ID; // 利用状況ボードを置くチャンネル

if (!TOKEN || !CLIENT_ID || !GUILD_ID || !CHANNEL_ID) {
  console.error("環境変数 DISCORD_TOKEN / CLIENT_ID / GUILD_ID / CHANNEL_ID を設定してください。");
  process.exit(1);
}

// ====== Discordクライアント ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages, // ボード復旧時にメッセージ検索で使用
  ],
});

// 利用中ユーザー（IDのSet）
const activeUsers = new Set();
// 現行ボードのメッセージ参照
let statusMessage = null;

// ボタンUI
const buttonsRow = new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId("start").setLabel("利用開始").setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId("end").setLabel("退出").setStyle(ButtonStyle.Danger)
);

// ボード描画
function renderStatus() {
  let body = "🏢 **事務所利用状況**\n------------------------\n";
  if (activeUsers.size === 0) {
    body += "現在利用者はいません";
  } else {
    body += "🟢 利用中:\n";
    for (const uid of activeUsers) body += `・<@${uid}>\n`;
  }
  return body;
}

// 既存ボード探索＆復旧（再起動時）
async function restoreBoard() {
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel?.isTextBased()) return;

  const msgs = await channel.messages.fetch({ limit: 50 });
  const mine = msgs
    .filter(m => m.author.id === client.user.id && m.content.startsWith("🏢 **事務所利用状況**"))
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

  if (mine.size === 0) return;

  statusMessage = mine.first();

  // ボード本文から <@123...> を抽出してactiveUsersを復元
  activeUsers.clear();
  const mentionRegex = /<@(\d+)>/g;
  let match;
  while ((match = mentionRegex.exec(statusMessage.content)) !== null) {
    activeUsers.add(match[1]);
  }
  console.log(`[restore] 復元: ${activeUsers.size}人`);
}

// /setup コマンド登録（ギルド限定＝反映が即時）
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const commands = [
    {
      name: "setup",
      description: "事務所利用状況ボードをこのサーバーに設置します",
    },
  ];
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("[ready] /setup を登録しました");
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
    await restoreBoard();
  } catch (e) {
    console.error(e);
  }
});

// スラッシュコマンド: /setup
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "setup") return;

  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel?.isTextBased()) {
    return interaction.reply({ content: "CHANNEL_ID がテキストチャンネルではありません。", ephemeral: true });
  }

  const msg = await channel.send({ content: renderStatus(), components: [buttonsRow] });
  statusMessage = msg;
  await interaction.reply({ content: `✅ ボードを <#${CHANNEL_ID}> に設置しました。`, ephemeral: true });
});

// ボタン
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  const uid = interaction.user.id;

  // 再起動後でstatusMessage未取得なら復旧を試みる
  if (!statusMessage) await restoreBoard();

  if (interaction.customId === "start") {
    if (!activeUsers.has(uid)) activeUsers.add(uid);
    await interaction.reply({ content: `🟢 利用開始を記録しました`, ephemeral: true });
  } else if (interaction.customId === "end") {
    if (activeUsers.has(uid)) activeUsers.delete(uid);
    await interaction.reply({ content: `🔴 退出を記録しました`, ephemeral: true });
  }

  if (statusMessage) {
    await statusMessage.edit({ content: renderStatus(), components: [buttonsRow] });
  } else {
    // 万一ボードが見つからない場合は、その場で作成
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (channel?.isTextBased()) {
      statusMessage = await channel.send({ content: renderStatus(), components: [buttonsRow] });
    }
  }
});

// ====== Webサーバ（Render無料Web Service用 Keep-Alive） ======
const app = express();
app.get("/", (_, res) => res.send("ok"));         // RenderのHealth Check/Ping用
app.get("/status", (_, res) => {
  res.json({ activeCount: activeUsers.size, users: Array.from(activeUsers) });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server on :${PORT}`));

client.login(TOKEN);
