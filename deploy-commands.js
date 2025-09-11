require('dotenv').config();
const { REST, Routes } = require('discord.js');

const commands = [
  {
    name: 'setup-office',
    description: 'このチャンネルに事務所利用パネルを設置する',
  },
  {
    name: 'remove-office',
    description: 'このチャンネルのパネル情報を削除する',
  }
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Started refreshing application (/) commands.');

    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands },
    );

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
})();
