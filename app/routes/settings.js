const os = require('os');
const path = require('path');
const Account = require('../core/account');
const router = require("express").Router();
const gbs = require('../../config/globals');
const core = require('../core');
const ipc = require('electron').ipcMain;

const baseSize = os.platform() === "win32" ? 330 : 270;

// Validation helper functions
function isValidAccountId(id) {
  // NeDB IDs are 16 character alphanumeric strings
  return typeof id === 'string' && /^[a-zA-Z0-9]{16}$/.test(id);
}

function sanitizeFolderPath(folderPath) {
  if (!folderPath || typeof folderPath !== 'string') {
    return null;
  }
  
  // Normalize path to prevent traversal attacks
  const normalized = path.normalize(folderPath);
  
  // Ensure path is absolute
  if (!path.isAbsolute(normalized)) {
    return null;
  }
  
  // Prevent path traversal attempts
  if (normalized.includes('..')) {
    return null;
  }
  
  return normalized;
}

router.get('/settings', async (req, res) => {
  let accounts = await core.accounts();

  res.render('settings', {accounts});

  /* Hack to set frontend to proper height */
  gbs.win.setSize(650, baseSize+80*Math.max(accounts.length,0.5));
});

router.get('/connect', (req, res) => {
  let account = new Account();
  res.redirect(account.authUrl);
});

router.get('/add', (req, res) => {
  res.send("Multiple accounts not yet supported");
});

router.get('/delete/:id', async (req, res) => {
  const accountId = req.params.id;
  
  // Validate account ID
  if (!isValidAccountId(accountId)) {
    return res.status(400).send('Invalid account ID');
  }
  
  let account = await core.getAccountById(accountId);
  if (!account) {
    return res.status(404).send('Account not found');
  }
  
  await core.removeAccount(account);

  res.redirect('/settings');
});

router.get('/authCallback', async (req, res, next) => {
  try {
    let code = req.query.code;
    
    // Validate OAuth code
    if (!code || typeof code !== 'string') {
      return res.status(400).send('Invalid authorization code');
    }

    let account = new Account();

    await account.handleCode(code);
    core.addAccount(account);

    res.redirect("/settings");
  } catch(err) {
    next(err);
  }
});

ipc.on('permanently-delete-setting', async (event, { accountId, permanentlyDeleteSetting}) => {
  /* Shortcut to web IPC. Does not use 'event.sender' as it can be closed and reopened */
  let web = () => {
    if (gbs.win) {
      return gbs.win.webContents;
    } else {
      return { send: () => { } };
    }
  };

  try {
    // Validate account ID
    if (!isValidAccountId(accountId)) {
      throw new Error('Invalid account ID');
    }
    
    let account = await core.getAccountById(accountId);
    if (!account) {
      throw new Error('Account not found');
    }
    
    account.permanentlyDeleteSetting = Boolean(permanentlyDeleteSetting);
    await account.save();
  } catch (err) {
    console.error(err);
    web().send('error', err.message);
  }
});

ipc.on('start-sync', async (event, {accountId, folder}) => {
  /* Shortcut to web IPC. Does not use 'event.sender' as it can be closed and reopened */
  let web = () => {
    if (gbs.win) {
      return gbs.win.webContents;
    } else {
      return { send: () => { } };
    }
  };
  
  try {
    // Validate account ID
    if (!isValidAccountId(accountId)) {
      throw new Error('Invalid account ID');
    }
    
    let account = await core.getAccountById(accountId);
    if (!account) {
      throw new Error('Account not found');
    }
    
    // Validate and sanitize folder path
    const sanitizedFolder = sanitizeFolderPath(folder);
    if (!sanitizedFolder) {
      throw new Error('Invalid folder path');
    }
    
    account.folder = sanitizedFolder;
    await account.save();
    await account.sync.start(update => web().send("sync-update", {accountId, update}));
    web().send('sync-end');
  } catch (err) {
    console.error(err);

    web().send('error', err.message);
    /* If synchronization didn't go through to the end, we enable the user to do it again */
    web().send('sync-enable', err.message);
  }
});

module.exports = router;
