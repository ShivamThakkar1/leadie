// Install dependencies:
// npm install telegraf axios mongoose dotenv express

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const mongoose = require('mongoose');
const express = require('express');

// MongoDB Schema
const clientSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  apiToken: { type: String, required: true },
  baseUrl: { type: String, default: 'http://localhost:5000/api/v1' },
  createdAt: { type: Date, default: Date.now },
  lastUsed: { type: Date, default: Date.now }
});

const Client = mongoose.model('Client', clientSchema);

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// Helper Functions
const reactToMessage = async (ctx, emoji) => {
  try {
    await ctx.setMessageReaction(emoji);
  } catch (error) {
    // Silently fail if reactions not supported
    console.log('Reaction not supported in this chat');
  }
};

const getClient = async (telegramId) => {
  return await Client.findOne({ telegramId: telegramId.toString() });
};

const makeApiRequest = async (client, endpoint, method = 'GET', data = null) => {
  try {
    const config = {
      method,
      url: `${client.baseUrl}${endpoint}`,
      headers: {
        'Authorization': `Bearer ${client.apiToken}`,
        'Content-Type': 'application/json'
      }
    };
    
    if (data) config.data = data;
    
    const response = await axios(config);
    await Client.updateOne(
      { telegramId: client.telegramId },
      { lastUsed: new Date() }
    );
    return response.data;
  } catch (error) {
    throw error.response?.data || { error: 'API request failed' };
  }
};

// Main Menu
const mainMenu = Markup.keyboard([
  ['📊 Jobs', '🎯 Targets'],
  ['👥 Leads', '📈 Content Analysis'],
  ['📉 Statistics', '⚙️ Settings'],
  ['❌ Cancel']
]).resize();

// Start Command
bot.command('start', async (ctx) => {
  await reactToMessage(ctx, '👋');
  const client = await getClient(ctx.from.id);
  
  if (!client) {
    await ctx.reply(
      '👋 Welcome to the API Management Bot!\n\n' +
      '🔑 To get started, please set your API token using:\n' +
      '/settoken YOUR_API_TOKEN\n\n' +
      '📝 Example:\n' +
      '/settoken abc123def456'
    );
  } else {
    await ctx.reply(
      `✅ Welcome back!\n\n` +
      `🆔 Your ID: ${ctx.from.first_name}\n` +
      `📅 Last used: ${client.lastUsed.toLocaleString()}\n\n` +
      `Choose an option below:`,
      mainMenu
    );
  }
});

// Set Token Command
bot.command('settoken', async (ctx) => {
  await reactToMessage(ctx, '🔑');
  const args = ctx.message.text.split(' ').slice(1);
  
  if (args.length === 0) {
    return ctx.reply('❌ Please provide your API token:\n/settoken YOUR_TOKEN');
  }
  
  const token = args[0];
  const loadingMsg = await ctx.reply('👁️ Verifying token...');
  
  try {
    // Test the token
    const testConfig = {
      method: 'GET',
      url: `${process.env.API_BASE_URL || 'http://localhost:5000/api/v1'}/stats`,
      headers: { 'Authorization': `Bearer ${token}` }
    };
    
    await axios(testConfig);
    
    // Save or update client
    await Client.findOneAndUpdate(
      { telegramId: ctx.from.id.toString() },
      {
        telegramId: ctx.from.id.toString(),
        apiToken: token,
        baseUrl: process.env.API_BASE_URL || 'http://localhost:5000/api/v1',
        lastUsed: new Date()
      },
      { upsert: true, new: true }
    );
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      '✅ Token verified and saved successfully!\n\nUse /start to access the menu.'
    );
    await reactToMessage(ctx, '✅');
  } catch (error) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      '❌ Invalid token or API is unreachable.\n\nPlease check your token and try again.'
    );
    await reactToMessage(ctx, '❌');
  }
});

// Set Base URL Command
bot.command('seturl', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  
  if (args.length === 0) {
    return ctx.reply('❌ Please provide the base URL:\n/seturl https://your-domain.com/api/v1');
  }
  
  const client = await getClient(ctx.from.id);
  if (!client) {
    return ctx.reply('❌ Please set your API token first using /settoken');
  }
  
  await Client.updateOne(
    { telegramId: ctx.from.id.toString() },
    { baseUrl: args[0] }
  );
  
  await ctx.reply('✅ Base URL updated successfully!');
});

// Jobs Handler
bot.hears('📊 Jobs', async (ctx) => {
  await reactToMessage(ctx, '👀');
  const client = await getClient(ctx.from.id);
  if (!client) return ctx.reply('❌ Please set your token first: /settoken');
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📋 List All Jobs', 'jobs_list')],
    [Markup.button.callback('➕ Create New Job', 'jobs_create')],
    [Markup.button.callback('🔙 Back to Menu', 'back_menu')]
  ]);
  
  await ctx.reply('📊 Job Management\n\nChoose an action:', keyboard);
});

// List Jobs
bot.action('jobs_list', async (ctx) => {
  await ctx.answerCbQuery('👁️ Loading jobs...');
  const client = await getClient(ctx.from.id);
  
  try {
    const data = await makeApiRequest(client, '/jobs?page=1&per_page=10');
    
    if (data.data.length === 0) {
      return ctx.editMessageText('📭 No jobs found.\n\nCreate your first job!');
    }
    
    const buttons = data.data.map(job => {
      const statusEmoji = {
        'queued': '⏳',
        'running': '🏃',
        'finished': '✅',
        'failed': '❌'
      }[job.status] || '❓';
      
      return [Markup.button.callback(
        `${statusEmoji} ${job.name}`,
        `job_${job.id}`
      )];
    });
    
    buttons.push([Markup.button.callback('🔙 Back', 'back_jobs')]);
    
    const totalPages = data.pagination.pages;
    const currentPage = data.pagination.page;
    
    await ctx.editMessageText(
      `📊 Jobs List (Page ${currentPage}/${totalPages})\n` +
      `📦 Total: ${data.pagination.total}\n\n` +
      `Select a job to view details:`,
      Markup.inlineKeyboard(buttons)
    );
  } catch (error) {
    await ctx.editMessageText(`❌ Error: ${error.error || 'Failed to fetch jobs'}`);
  }
});

// Job Details
bot.action(/job_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery('👁️ Loading job details...');
  const client = await getClient(ctx.from.id);
  const jobId = ctx.match[1];
  
  try {
    const data = await makeApiRequest(client, `/jobs/${jobId}`);
    const job = data.data;
    
    const statusEmoji = {
      'queued': '⏳',
      'running': '🏃',
      'finished': '✅',
      'failed': '❌'
    }[job.status] || '❓';
    
    const message = 
      `📊 Job Details\n\n` +
      `🆔 ID: ${job.id}\n` +
      `📝 Name: ${job.name}\n` +
      `${statusEmoji} Status: ${job.status}\n` +
      `🔧 Type: ${job.job_type}\n` +
      `👥 Users Stored: ${job.users_stored || 0}\n` +
      `📅 Created: ${new Date(job.created_at).toLocaleString()}`;
    
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('▶️ Run Job', `run_job_${jobId}`)],
      [Markup.button.callback('🗑️ Delete', `delete_job_${jobId}`)],
      [Markup.button.callback('🔙 Back to List', 'jobs_list')]
    ]);
    
    await ctx.editMessageText(message, keyboard);
  } catch (error) {
    await ctx.editMessageText(`❌ Error: ${error.error || 'Failed to fetch job'}`);
  }
});

// Run Job
bot.action(/run_job_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery('👁️ Starting job...');
  const client = await getClient(ctx.from.id);
  const jobId = ctx.match[1];
  
  try {
    await makeApiRequest(client, `/jobs/${jobId}/run`, 'POST');
    await ctx.answerCbQuery('✅ Job started!', { show_alert: true });
    
    // React to the original message
    try {
      await ctx.telegram.setMessageReaction(ctx.chat.id, ctx.callbackQuery.message.message_id, '🚀');
    } catch (e) {}
    
    ctx.scene.reenter();
  } catch (error) {
    await ctx.answerCbQuery(`❌ ${error.error}`, { show_alert: true });
  }
});

// Delete Job
bot.action(/delete_job_(\d+)/, async (ctx) => {
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Yes, Delete', `confirm_delete_job_${ctx.match[1]}`),
      Markup.button.callback('❌ Cancel', 'jobs_list')
    ]
  ]);
  
  await ctx.editMessageText(
    '⚠️ Are you sure you want to delete this job?\n\nThis action cannot be undone.',
    keyboard
  );
});

bot.action(/confirm_delete_job_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery('👁️ Deleting job...');
  const client = await getClient(ctx.from.id);
  const jobId = ctx.match[1];
  
  try {
    await makeApiRequest(client, `/jobs/${jobId}`, 'DELETE');
    await ctx.answerCbQuery('✅ Job deleted!', { show_alert: true });
    
    // React to the message
    try {
      await ctx.telegram.setMessageReaction(ctx.chat.id, ctx.callbackQuery.message.message_id, '🗑');
    } catch (e) {}
    
    await ctx.editMessageText('✅ Job deleted successfully!');
    setTimeout(() => ctx.reply('Choose an option:', mainMenu), 1000);
  } catch (error) {
    await ctx.answerCbQuery(`❌ ${error.error}`, { show_alert: true });
  }
});

// Targets Handler
bot.hears('🎯 Targets', async (ctx) => {
  await reactToMessage(ctx, '👀');
  const client = await getClient(ctx.from.id);
  if (!client) return ctx.reply('❌ Please set your token first: /settoken');
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📋 List Targets', 'targets_list')],
    [Markup.button.callback('➕ Create Target', 'targets_create')],
    [Markup.button.callback('🔙 Back', 'back_menu')]
  ]);
  
  await ctx.reply('🎯 Target Management\n\nChoose an action:', keyboard);
});

// List Targets
bot.action('targets_list', async (ctx) => {
  await ctx.answerCbQuery('👁️ Loading targets...');
  const client = await getClient(ctx.from.id);
  
  try {
    const data = await makeApiRequest(client, '/targets?page=1&per_page=10');
    
    if (data.data.length === 0) {
      return ctx.editMessageText('📭 No targets found.');
    }
    
    const buttons = data.data.map(target => [
      Markup.button.callback(
        `🎯 ${target.identifier}`,
        `target_${target.id}`
      )
    ]);
    
    buttons.push([Markup.button.callback('🔙 Back', 'back_targets')]);
    
    await ctx.editMessageText(
      `🎯 Targets (Page ${data.pagination.page}/${data.pagination.pages})\n\n` +
      `Select a target:`,
      Markup.inlineKeyboard(buttons)
    );
  } catch (error) {
    await ctx.editMessageText(`❌ Error: ${error.error || 'Failed to fetch targets'}`);
  }
});

// Leads Handler
bot.hears('👥 Leads', async (ctx) => {
  await reactToMessage(ctx, '👀');
  const client = await getClient(ctx.from.id);
  if (!client) return ctx.reply('❌ Please set your token first: /settoken');
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📋 All Leads', 'leads_all')],
    [Markup.button.callback('✅ Outreach Ready', 'leads_ready')],
    [Markup.button.callback('🔙 Back', 'back_menu')]
  ]);
  
  await ctx.reply('👥 Leads Management\n\nChoose an option:', keyboard);
});

// List Leads
bot.action(/leads_(all|ready)/, async (ctx) => {
  await ctx.answerCbQuery('👁️ Loading leads...');
  const client = await getClient(ctx.from.id);
  const type = ctx.match[1];
  const query = type === 'ready' ? '?outreach_ready=true&page=1' : '?page=1';
  
  try {
    const data = await makeApiRequest(client, `/leads${query}`);
    
    if (data.data.length === 0) {
      return ctx.editMessageText('📭 No leads found.');
    }
    
    const buttons = data.data.map(lead => [
      Markup.button.callback(
        `👤 ${lead.username} (${lead.followers} followers)`,
        `lead_${lead.id}`
      )
    ]);
    
    buttons.push([Markup.button.callback('🔙 Back', 'back_leads')]);
    
    await ctx.editMessageText(
      `👥 Leads (Page ${data.pagination.page}/${data.pagination.pages})\n` +
      `Total: ${data.pagination.total}\n\n` +
      `Select a lead:`,
      Markup.inlineKeyboard(buttons)
    );
  } catch (error) {
    await ctx.editMessageText(`❌ Error: ${error.error || 'Failed to fetch leads'}`);
  }
});

// Lead Details
bot.action(/lead_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery('👁️ Loading lead details...');
  const client = await getClient(ctx.from.id);
  const leadId = ctx.match[1];
  
  try {
    const data = await makeApiRequest(client, `/leads/${leadId}`);
    const lead = data.data;
    
    const message = 
      `👤 Lead Details\n\n` +
      `🆔 Username: @${lead.username}\n` +
      `👤 Name: ${lead.full_name || 'N/A'}\n` +
      `📊 Followers: ${lead.followers?.toLocaleString() || 0}\n` +
      `📧 Email: ${lead.emails || 'Not available'}\n` +
      `📱 Platform: ${lead.platform}`;
    
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Back to List', type === 'ready' ? 'leads_ready' : 'leads_all')]
    ]);
    
    await ctx.editMessageText(message, keyboard);
  } catch (error) {
    await ctx.editMessageText(`❌ Error: ${error.error || 'Failed to fetch lead'}`);
  }
});

// Statistics
bot.hears('📉 Statistics', async (ctx) => {
  await reactToMessage(ctx, '👀');
  const client = await getClient(ctx.from.id);
  if (!client) return ctx.reply('❌ Please set your token first: /settoken');
  
  const loadingMsg = await ctx.reply('👁️ Fetching statistics...');
  
  try {
    const data = await makeApiRequest(client, '/stats');
    const stats = data.data;
    
    const message = 
      `📊 Statistics Dashboard\n\n` +
      `👥 Total Leads: ${stats.total_leads?.toLocaleString() || 0}\n` +
      `📊 Total Jobs: ${stats.total_jobs || 0}\n` +
      `🎯 Total Targets: ${stats.total_targets || 0}\n` +
      `📈 Content Analysis: ${stats.total_content_analysis || 0}\n\n` +
      `🔑 API Usage:\n` +
      `├ Total Requests: ${stats.total_api_requests?.toLocaleString() || 0}\n` +
      `├ Today: ${stats.today_api_requests || 0}\n` +
      `├ Token Requests: ${stats.token_requests || 0}\n` +
      `└ Last Used: ${stats.token_last_used ? new Date(stats.token_last_used).toLocaleString() : 'Never'}`;
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      message
    );
    await reactToMessage(ctx, '✅');
  } catch (error) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      `❌ Error: ${error.error || 'Failed to fetch statistics'}`
    );
    await reactToMessage(ctx, '❌');
  }
});

// Content Analysis
bot.hears('📈 Content Analysis', async (ctx) => {
  await reactToMessage(ctx, '👀');
  const client = await getClient(ctx.from.id);
  if (!client) return ctx.reply('❌ Please set your token first: /settoken');
  
  const loadingMsg = await ctx.reply('👁️ Loading content analysis...');
  
  try {
    const data = await makeApiRequest(client, '/content-analysis?page=1&per_page=5');
    
    if (data.data.length === 0) {
      await reactToMessage(ctx, '🤷');
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        '📭 No content analysis data found.'
      );
    }
    
    let message = `📈 Content Analysis (Page 1/${data.pagination.pages})\n\n`;
    
    data.data.forEach((content, idx) => {
      message += 
        `${idx + 1}. 📱 ${content.platform} - @${content.username}\n` +
        `   ❤️ Likes: ${content.likes_count?.toLocaleString() || 0}\n` +
        `   💬 Comments: ${content.comments_count || 0}\n` +
        `   👁️ Views: ${content.views_count?.toLocaleString() || 0}\n` +
        `   📊 Engagement: ${content.engagement_rate || 'N/A'}\n\n`;
    });
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      message
    );
    await reactToMessage(ctx, '✅');
  } catch (error) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      `❌ Error: ${error.error || 'Failed to fetch content analysis'}`
    );
    await reactToMessage(ctx, '❌');
  }
});

// Settings
bot.hears('⚙️ Settings', async (ctx) => {
  await reactToMessage(ctx, '⚙️');
  const client = await getClient(ctx.from.id);
  
  if (!client) {
    return ctx.reply('❌ Please set your token first: /settoken');
  }
  
  const message = 
    `⚙️ Settings\n\n` +
    `🆔 Telegram ID: ${ctx.from.id}\n` +
    `🔑 Token: ${client.apiToken.substring(0, 10)}...\n` +
    `🌐 Base URL: ${client.baseUrl}\n` +
    `📅 Created: ${client.createdAt.toLocaleString()}\n\n` +
    `Commands:\n` +
    `/settoken - Update API token\n` +
    `/seturl - Update base URL\n` +
    `/deleteaccount - Remove your data`;
  
  await ctx.reply(message);
});

// Delete Account
bot.command('deleteaccount', async (ctx) => {
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Yes, Delete', 'confirm_delete_account'),
      Markup.button.callback('❌ Cancel', 'cancel_delete')
    ]
  ]);
  
  await ctx.reply(
    '⚠️ Are you sure you want to delete your account?\n\n' +
    'This will remove all your saved data.',
    keyboard
  );
});

bot.action('confirm_delete_account', async (ctx) => {
  await ctx.answerCbQuery('👁️ Deleting account...');
  
  await Client.deleteOne({ telegramId: ctx.from.id.toString() });
  
  // React to the message
  try {
    await ctx.telegram.setMessageReaction(ctx.chat.id, ctx.callbackQuery.message.message_id, '👋');
  } catch (e) {}
  
  await ctx.editMessageText(
    '✅ Account deleted successfully!\n\n' +
    'Use /settoken to create a new account.'
  );
});

bot.action('cancel_delete', async (ctx) => {
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('❌ Account deletion cancelled.');
});

// Back Navigation
bot.action('back_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  await ctx.reply('Choose an option:', mainMenu);
});

bot.action('back_jobs', async (ctx) => {
  await ctx.answerCbQuery();
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📋 List All Jobs', 'jobs_list')],
    [Markup.button.callback('➕ Create New Job', 'jobs_create')],
    [Markup.button.callback('🔙 Back to Menu', 'back_menu')]
  ]);
  await ctx.editMessageText('📊 Job Management\n\nChoose an action:', keyboard);
});

bot.action('back_targets', async (ctx) => {
  await ctx.answerCbQuery();
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📋 List Targets', 'targets_list')],
    [Markup.button.callback('➕ Create Target', 'targets_create')],
    [Markup.button.callback('🔙 Back', 'back_menu')]
  ]);
  await ctx.editMessageText('🎯 Target Management\n\nChoose an action:', keyboard);
});

bot.action('back_leads', async (ctx) => {
  await ctx.answerCbQuery();
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📋 All Leads', 'leads_all')],
    [Markup.button.callback('✅ Outreach Ready', 'leads_ready')],
    [Markup.button.callback('🔙 Back', 'back_menu')]
  ]);
  await ctx.editMessageText('👥 Leads Management\n\nChoose an option:', keyboard);
});

// Cancel
bot.hears('❌ Cancel', async (ctx) => {
  await ctx.reply('Operation cancelled.', mainMenu);
});

// Error Handler
bot.catch((err, ctx) => {
  console.error('Bot Error:', err);
  ctx.reply('❌ An error occurred. Please try again.');
});

// Launch Bot
bot.launch().then(() => {
  console.log('🤖 Bot is running!');
});

// Create Express server for Render port binding
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({
    status: 'active',
    bot: 'Telegram API Bot',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    bot: 'running'
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
