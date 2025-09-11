// deploy-commands.js
require('dotenv').config();
const { REST, Routes } = require('discord.js');

const commands = [
  { name: 'setup-office', description: 'このチャンネルに事務所利用パネルを設置します（管理者向け）' },
  { name: 'remove-office', description: 'このチャンネルの事務所パネルを解除します（管理者向け）' }
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering guild commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
})();
