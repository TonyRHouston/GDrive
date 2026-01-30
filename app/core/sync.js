const assert = require('assert');
const path = require("path");
const fs = require("fs-extra");
const mkdirp = require("mkdirp-promise");
const delay = require("delay");
const deepEqual = require("deep-equal");
const md5file = require('md5-file/promise');
const EventEmitter = require('events');

const {log, verbose, debug, error} = require('../modules/logging');
const LocalWatcher = require('./localwatcher');
const globals = require('../../config/globals');

const fileInfoFields = "id, name, mimeType, md5Checksum, size, modifiedTime, parents, trashed";
const listFilesFields = `nextPageToken, files(${fileInfoFields})`;
const changeInfoFields = `time, removed, fileId, file(${fileInfoFields})`;
const changesListFields = `nextPageToken, newStartPageToken, changes(${changeInfoFields})`;

const toSave = ["changeToken", "fileInfo", "synced", "rootId", "changesToExecute", "onLocalDrive"];

class Sync extends EventEmitter {
  constructor(account) {
    super();

    this.account = account;
    this.fileInfo = {};
    this.paths = {};
    this.onLocalDrive = {};//Keep track of files already downloaded locally
    this.lastChanges = {};
    this.lastChangesUpdated = Date.now();
    this.queued = [];
    this.rootId = null;
    this.synced = false;
    this.changeToken = null;
    this.changesToExecute = null;
    this.loaded = false;
    this.watchingChanges = false;
    this.closed = false;
    this.savedTime = 0;
    this.changesSinceSave = 0;
    this.handlingRemoteChange = false;
    this.handlingLocalChange = false;
    this.parentInfoCache = new Map(); // Cache for parent folder info
    this.watcherListeners = new Map(); // Store listener references per event for cleanup

    this.watcher = new LocalWatcher(this);
    this.initWatcher();

    /* Check if already in memory */
    this.load();
  }

  set handlingLocalChange(value) {
    if (this.handlingLocalChange === value) {
      return;
    }
    this._handlingLocalChange = value;
    console.log("local change", value, this.syncing || this.handlingLocalChange || this.handlingRemoteChange);
    this.emit("syncing", this.syncing || this.handlingLocalChange || this.handlingRemoteChange);
    this.notifyChanges();
  }

  set handlingRemoteChange(value) {
    if (this.handlingRemoteChange === value) {
      return;
    }
    this._handlingRemoteChange = value;
    console.log("remote change", value, this.syncing || this.handlingLocalChange || this.handlingRemoteChange);
    this.emit("syncing", this.syncing || this.handlingLocalChange || this.handlingRemoteChange);
    this.notifyChanges();
  }

  set syncing(value) {
    if (this.syncing === value) {
      return;
    }
    this._syncing = value;
    console.log("syncing", this.handlingChanges);
    this.emit("syncing", this.handlingChanges);
    this.notifyChanges();
  }

  get syncing() {
    return this._syncing;
  }

  get handlingRemoteChange() {
    return this._handlingRemoteChange;
  }

  get handlingLocalChange() {
    return this._handlingLocalChange;
  }

  get handlingChanges () {
    return this.syncing || this.handlingLocalChange || this.handlingRemoteChange;
  }

  get running() {
    return "id" in this;
  }

  get drive() {
    return this.account.drive;
  }

  get folder() {
    return this.account.folder;
  }

  /* check if file is in local registry */
  locallyRegistered(path) {
    /* base64 encoding because of nedb */
    return Buffer.from(path).toString('base64') in this.onLocalDrive;
  }

  registerLocalFile(path) {
    /* base64 encoding because of nedb */
    this.onLocalDrive[Buffer.from(path).toString('base64')] = true;
    this.changesSinceSave += 1;
  }

  unregisterLocalFile(path) {
    delete this.onLocalDrive[Buffer.from(path).toString('base64')];
    this.changesSinceSave += 1;
  }

  formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  async ParallelMapFlow(files, notifyCallback) {
    let notify = notifyCallback || (() => { });
    let counter = 0;
    let ignored = 0;
    let fileSize = 0;

    while (files.length > 0) {

      var fileQueue = [];
      for (let i = 0; i < 10; i++) {
        if (files.length >= 1) {
          fileQueue.push(files.shift());
        }else{
          break;
        }
      }

      // Pre-fetch all parent info for this batch of files
      const parentIds = new Set();
      for (let file of fileQueue) {
        if (file.parents) {
          for (let parent of file.parents) {
            if (this._needsParentFetch(parent)) {
              parentIds.add(parent);
            }
          }
        }
      }
      
      // Batch fetch parent info if needed
      if (parentIds.size > 0) {
        const batchResults = await this.getFileInfoBatch(Array.from(parentIds));
        batchResults.forEach((parentInfo, parentId) => {
          if (parentInfo) {
            this.parentInfoCache.set(parentId, parentInfo);
          }
        });
      }

      let results = fileQueue.map(
        async (file) => {
          if (this.shouldIgnoreFile(file)) {
            ignored += 1;
            notify(`${counter} files downloaded, ${ignored} files ignored...`);
          } else {
            counter += 1;
            if (Number(file.size) >= 0) {
              fileSize += Number(file.size);
            }
            console.log(`Downloading #${counter} ${file.name}`);
            await this.finishLoading();
            await this.downloadFile(file);
            return Number(file.size);
          }
        }
      );
      for (const result of results) {
        await result;
      }
      notify(`${counter} (${this.formatBytes(fileSize)}) files downloaded, ${ignored} files ignored...`);
    }
 
    return { counter, ignored, fileSize};
  }

  async start(notifyCallback) {
    await this.finishLoading();

    assert(!this.syncing, "Sync already in progress");
    this.syncing = true;

    try {
      let notify = notifyCallback || (() => {});

      let rootInfo = await this.getFileInfo("root");
      this.rootId = rootInfo.id;

      notify("Watching changes in the remote folder...");
      await this.startWatchingChanges();

      notify("Getting files info...");

      let files = await this.downloadFolderStructure("root");
      await this.computePaths();

      let result = await this.ParallelMapFlow(files, notifyCallback);
      notify(`All done! ${result.counter} (${this.formatBytes(result.fileSize)}) files downloaded and ${result.ignored} ignored.`);
      this.syncing = false;
      this.synced = true;

      await this.save();
    } catch (err) {
      this.syncing = false;
      throw err;
    }
  }

  closeWatcher() {
    // Remove all watcher event listeners to prevent memory leaks
    for (const [event, listeners] of this.watcherListeners) {
      // listeners is an array of listener functions for this event
      if (Array.isArray(listeners)) {
        for (const listener of listeners) {
          this.watcher.off(event, listener);
        }
      }
    }
    this.watcherListeners.clear();
  }

  async close() {
    this.closeWatcher();
    this.watcher.stopWatching();
    this.closed = true;
  }

  async startWatchingChanges() {
    await this.finishLoading();

    if (this.changeToken) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.drive.changes.getStartPageToken({}, (err, res) => {
        if (err) {
          return reject(err);
        }
        debug("Start token for watching changes: ", res.startPageToken);

        /* Make sure a parallel execution didn't get another token first. Once we've got a token, we stick with it */
        if (!this.changeToken) {
          this.changeToken = res.startPageToken;
        }

        resolve(res);
      });
    });
  }

  /* Continuously watch for new changes and apply them, loop function */
  async watchChanges() {
    await this.finishLoading();

    /* Make sure only one instance of this function is running. Love that nodejs is asynchronous but runs on one thread, atomicity is guaranteed */
    if (this.watchingChanges) {
      return;
    }
    this.watchingChanges = true;

    log("Watching remote changes...");

    try {
      if (!this.changeToken) {
        error(new Error("Error in application flow, no valid change token"));
        await this.startWatchingChanges();
      }

      let pollDelay = 8000; // Start with 8 seconds
      const initialDelay = 8000; // Reset to initial when syncing completes
      const minDelay = 2000; // Minimum polling interval when changes detected
      const maxDelay = 30000; // Maximum polling interval when idle
      const backoffMultiplier = 1.5; // Exponential backoff factor

      while (!this.closed) {
        /* Don't handle changes at the same time as syncing... */
        if (!this.syncing && this.synced) {
          const changesDetected = await this.handleNewChanges();
          // Reduce delay if changes were detected, increase if idle
          if (changesDetected) {
            pollDelay = minDelay;
          } else {
            pollDelay = Math.min(pollDelay * backoffMultiplier, maxDelay);
          }
        } else {
          // Reset to initial delay when syncing starts to catch changes sooner after sync completes
          pollDelay = initialDelay;
        }
        await delay(pollDelay);
      }
    } catch (err) {
      log("Error when watching changes...");
      this.watchingChanges = false;
      this.handlingRemoteChange = false;

      /* For the unhandledRejection handler */
      err.syncObject = this;
      err.watcher = true;

      throw err;
    }
  }

  async handleNewChanges() {
    this.changesToExecute = await this.getNewChanges();
    const changesCount = (this.changesToExecute || []).length;

    await this.handleChanges();
    
    return changesCount > 0;
  }

  /* loop function */
  async handleChanges() {

    while((this.changesToExecute||[]).length > 0 && !this.closed) {
      this.handlingRemoteChange = true;

      // let nextChange = this.changesToExecute.shift();

      let nextChangeQueue = [];
      for (let i = 0; i < 10; i++) {
        if (this.changesToExecute.length >= 1) {
          nextChangeQueue.push(this.changesToExecute.shift());
        }else{
          break;
        }
      }
      let results = nextChangeQueue.map(
        async (nextChange) => {
          if (await this.handleChange(nextChange)) {
            await this.save();
          } else {
            this.changesSinceSave += 1;
          }
        }
      );
      for (const result of results) {
        await result;
      }
    }
    this.handlingRemoteChange = false;

    /* Notify user of changes */
    this.notifyChanges();

    /* Save regularly if there are changes, even if they're worthless. At least it updates the change token. */
    let elapsedTime = Date.now() - this.savedTime;
    if (elapsedTime > 30000 && this.changesSinceSave > 0) {
      await this.save();
    }
  }

  async handleChange(change) {
    /* Todo */
    verbose("Change", change);

    /* Deleted file */
    if (change.removed || change.file.trashed) {
      verbose("file removal");
      return this.logChange("removed", await this.removeFileLocally(change.fileId));
    }

    debug(change.fileId, this.fileInfo[change.fileId]);

    /* New file */
    if (!(change.fileId in this.fileInfo)) {
      verbose("new file");
      return this.logChange("added", await this.addFileLocally(change.file));
    }

    /* Changed file */
    let newInfo = change.file;
    let oldInfo = this.fileInfo[change.fileId];
    await this.storeFileInfo(newInfo);

    if (this.noChange(oldInfo, newInfo)) {
      log("Same main info, ignoring change for file ", newInfo.name);
      /* Nothing happened */
      return false;
    }

    let oldPaths = await this.getPaths(oldInfo);
    let newPaths = await this.getPaths(newInfo);

    if (newPaths.length == 0 && oldPaths.length == 0) {
      verbose("Not in main folder, ignoring");
      return false;
    }

    if (newInfo.md5Checksum != oldInfo.md5Checksum) {
      log("Different checksum, redownloading");
      /* Content changed, may as well delete it and redownload it */
      await this.removeFileLocally(oldInfo.id);
      await this.addFileLocally(newInfo);

      this.logChange("updated", true);

      return true;
    }

    /* Changed Paths */
    if (oldPaths.length == 0) {
      log("Wasn't in main folder, downloading");
      return this.logChange("added", this.addFileLocally(newInfo));
    }

    if (this.shouldIgnoreFile(newInfo)) {
      verbose("Ignoring file, content worthless");
      return false;
    }

    oldPaths.sort();
    newPaths.sort();

    if (deepEqual(oldPaths, newPaths)) {
      verbose("Same file names, ignoring");
      return false;
    }

    log("Moving files");
    await this.changePaths(oldPaths, newPaths);
    return true;
  }

  async notifyChanges() {
    //Give time for other changes to happen, in order to group them all
    if (this.handlingChanges) {
      return;
    }
    if (!deepEqual({}, this.lastChanges)) {
      this.emit("filesChanged", this.lastChanges);
      this.lastChanges = {};
    }
  }

  /* Log a change, if it happened, and return if it happened or not */
  logChange(type, yesOrNo) {
    if (yesOrNo) {
      this.lastChanges[type] = this.lastChanges[type] || 0;
      this.lastChanges[type] += 1;
      log("Last changes updated:", this.lastChanges);
      this.lastChangesUpdated = Date.now();
    }
    return yesOrNo;
  }

  noChange(oldInfo, newInfo) {
    if (newInfo.modifiedTime > oldInfo.modifiedTime) {
      return false;
    }
    if (oldInfo.name != newInfo.name) {
      return false;
    }
    if (!deepEqual(oldInfo.parents, newInfo.parents)) {
      return false;
    }
    return true;
  }

  async addFileLocally(fileInfo) {
    await this.storeFileInfo(fileInfo);
    let res = await this.downloadFile(fileInfo);

    if (res) {
      this.logChange({type:"added", number: 1});
    }
    return res;
  }

  async onLocalFileAdded(src) {
    debug("On local file added", src);

    try {
      await fs.access(src);
    } catch (err) {
      debug("Not present on file system");
      return;
    }

    if (src in this.paths) {
      let id = this.paths[src];
      if (id in this.fileInfo) {
        debug("File already in drive's memory, updating instead");
        return this.onLocalFileUpdated(src);
      }
    }

    /* Create local file info */
    let info = {
      //id: uuid(),
      name: path.basename(src),
      //md5Checksum: await md5file(src),
      parents: [await this.getParent(src)],
      //mimeType: "image/jpeg"
    };

    verbose("Local info", info);
    let addRemotely = () => new Promise((resolve, reject) => {
      log("Adding new file to remote drive.");
      this.drive.files.create({
        resource: info,
        media: {
          body: fs.createReadStream(src)
        },
        fields: fileInfoFields
      }, (err, result) => {
        if (err) {
          error(err);
          return reject(err);
        }
        verbose("Result", result);
        resolve(result);
      });
    });

    let result = await this.tryTwice(addRemotely);

    this.logChange("added", true);

    await this.storeFileInfo(result);
    await this.save();
  }

  async onLocalFileUpdated(src) {
    debug("onLocalFileUpdated", src);

    try {
      await fs.access(src);
    } catch (err) {
      debug("Not present on file system");
      return;
    }

    if (! (src in this.paths)) {
      debug("Not in existing paths, adding it instead");
      return this.onLocalFileAdded(src);
    }

    let id = this.paths[src];

    if (!(id in this.fileInfo)) {
      debug("Not in existing file info structure, adding it instead");
      return this.onLocalFileAdded(src);
    }

    let info = this.fileInfo[id];
    if (this.shouldIgnoreFile(info)) {
      debug("Worthless file, ignoring");
      return;
    }

    let computedmd5 = await md5file(src);
    if (info.md5Checksum == computedmd5) {
      debug("No change in md5 sum, ignoring");
      return;
    }

    info.md5Checksum = computedmd5;

    let updateRemotely = () => new Promise((resolve, reject) => {
      log("Updating file to drive.");
      this.drive.files.update({
        fileId: id,
        media: {
          body: fs.createReadStream(src)
        },
        fields: fileInfoFields
      }, (err, result) => {
        if (err) {
          error(err);
          return reject(err);
        }
        verbose("Result", result);
        resolve(result);
      });
    });

    let result = await this.tryTwice(updateRemotely);
    await this.storeFileInfo(result);

    /* Update aliases */
    let paths = await this.getPaths(result);
    for (let path of paths) {
      if (path != src) {
        this.watcher.ignore(path);
        await fs.copy(src, path);
      }
    }

    this.logChange("updated", true);

    await this.save();
  }

  async onLocalFileRemoved(src) {
    verbose("onLocalFileRemoved", src);

    if (!(src in this.paths)) {
      debug(`Not existing in path architecture (${Object.keys(this.paths).length} paths)`);
      return;
    }

    let id = this.paths[src];

    verbose("Local info", this.fileInfo[id]);

    if (id in this.fileInfo) {
      //Removes aliases
      if (await this.removeFileLocally(id)) {
        await this.save();
      }
    } else {
      delete this.paths[src];
    }

    if (this.account.permanentlyDeleteSetting) {
      await this.permanentlyDelete(id);
    } else {
      await this.moveToTrash(id);
   }

  }

  async permanentlyDelete(id) {
    let rmRemotely = () => new Promise((resolve, reject) => {
      log("Deleting file on drive.", id);
      this.drive.files.delete({ fileId: id }, (err, result) => {
        if (err) {
          error(err);
          return reject(err);
        }
        verbose("Result", result);
        resolve(result);
      });
    });
    await this.tryTwice(rmRemotely);
    this.logChange("removed", true);
  }

  async moveToTrash(id) {
    let moveToTrash = () => new Promise((resolve, reject) => {
      log("Updating file to drive.");
      this.drive.files.update({
        resource: {
          'trashed': true
        },
        fileId: id
      }, (err, result) => {
        if (err) {
          error(err);
          return reject(err);
        }
        verbose("Result", result);
        resolve(result);
      });
    });
    await this.tryTwice(moveToTrash);
    this.logChange("move to trash", true);
  }

  async onLocalDirAdded(src) {
    verbose("onLocalDirAdded", src);

    if (src in this.paths) {
      let id = this.paths[src];
      if (id in this.fileInfo && this.isFolder(this.fileInfo[id])) {
        debug("Folder already in drive's memory");
        return;
      }
    }

    /* Create local file info */
    let info = {
      name: path.basename(src),
      parents: [await this.getParent(src)],
      mimeType: "application/vnd.google-apps.folder"
    };

    verbose("Local info", info);
    let addRemotely = () => new Promise((resolve, reject) => {
      log("Adding directory to drive.");
      this.drive.files.create({
        resource: info,
        fields: fileInfoFields
      }, (err, result) => {
        if (err) {
          error(err);
          return reject(err);
        }
        log("Result", result);
        resolve(result);
      });
    });

    let result = await this.tryTwice(addRemotely);

    await this.storeFileInfo(result);
    await this.save();
  }

  async onLocalDirRemoved(src) {
    if (src == this.folder) {
      error("Google drive folder removed?!?!?!?");
      process.exit(1);
    }
    verbose("onLocalDirRemoved", src);

    this.onLocalFileRemoved(src);
  }

  async removeFileLocally(fileId) {
    if (!(fileId in this.fileInfo)) {
      debug("Unknown file id asked to be removed", fileId);
      return false;
    }

    let fileInfo = this.fileInfo[fileId];
    let paths = await this.getPaths(fileInfo);

    delete this.fileInfo[fileId];
    paths.forEach(path => delete this.paths[path]);

    if (paths.length == 0) {
      return false;
    }

    let removed = false;
    for (let path of paths) {
      try {
        await fs.access(path);
        this.watcher.ignore(path);
        await fs.remove(path);
        removed = true;
      } catch (err) {
        // File doesn't exist, skip it
      }
    }

    if (removed) {
      console.log("removed file locally");
    }

    return removed;
  }

  async getNewChanges() {
    let changes = [];
    let pageToken = this.changeToken;

    while (pageToken) {
      let result = await new Promise((resolve, reject) => {
        this.drive.changes.list({
          corpora: "user",
          spaces: "drive",
          pageSize: 1000,
          pageToken,
          restrictToMyDrive: true,
          fields: changesListFields
        }, (err, res) => {
          if (err) {
            return reject(err);
          }
          resolve(res);
        });
      });

      pageToken = result.nextPageToken;
      changes = changes.concat(result.changes);

      if (result.newStartPageToken) {
        this.changeToken = result.newStartPageToken;
      }
    }

    //update connectivity here
    globals.updateConnectivity(true);

    return changes;
  }

  async downloadFolderStructure(folder) {
    await this.finishLoading();

    /* Try avoiding triggering antispam filters on Google's side, given the quantity of data */
    await delay(110);

    verbose("Downloading folder structure for ", folder);
    let files = await this.folderContents(folder);

    let res = [].concat(files);//clone to a different array
    for (let file of files) {
      if (file.mimeType.includes("folder")) {
        res = res.concat(await this.downloadFolderStructure(file.id));
      }
      await this.storeFileInfo(file);
    }

    return res;
  }

  async folderContents(folder) {
    await this.finishLoading();

    let q = folder ? `trashed = false and "${folder}" in parents` : null;

    let {nextPageToken, files} = await this.filesListChunk({folder,q});

    debug(files, nextPageToken);
    debug("(Chunk 1)");

    let counter = 1;
    while(nextPageToken) {
      /* Try avoiding triggering antispam filters on Google's side, given the quantity of data */
      await delay(20);

      let data = await this.filesListChunk({pageToken: nextPageToken, q});
      nextPageToken = data.nextPageToken;
      files = files.concat(data.files);

      counter += 1;
      debug(data);
      debug(`(Chunk ${counter})`, nextPageToken);
    }

    log("Files list done!");

    return files;
  }

  async filesListChunk(arg) {
    await this.finishLoading();

    let {pageToken, q} = arg;

    let getChunk = () => new Promise((resolve, reject) => {
      q = q || 'trashed = false';
      let args = {
        fields: listFilesFields,
        corpora: "user",
        spaces: "drive",
        pageSize: 1000,
        q
      };

      if (pageToken) {
        args.pageToken = pageToken;
      }
      debug("Getting files chunk", args);
      this.drive.files.list(args, (err, result) => {
        if (err) {
          return reject(err);
        }

        resolve(result);
      });
    });

    return await this.tryTwice(getChunk);
  }

  /* Helper to check if parent info needs to be fetched (not in cache or fileInfo) */
  _needsParentFetch(parentId) {
    return !this.parentInfoCache.has(parentId) && !(parentId in this.fileInfo);
  }

  async getPaths(fileInfo) {
    if (fileInfo === null) {
      return [];
    }

    if (fileInfo.id == this.rootId) {
      return [this.folder];
    }
    if (!fileInfo.parents) {
      return [];
    }

    let ret = [];

    // Collect all parent IDs that need to be fetched
    const parentsToFetch = [];
    for (let parent of fileInfo.parents) {
      if (this._needsParentFetch(parent)) {
        parentsToFetch.push(parent);
      }
    }

    // Batch fetch all parents if there are any to fetch
    if (parentsToFetch.length > 0) {
      const batchResults = await this.getFileInfoBatch(parentsToFetch);
      batchResults.forEach((parentInfo, parentId) => {
        if (parentInfo) {
          this.parentInfoCache.set(parentId, parentInfo);
        }
      });
    }

    // Now process all parents (all should be cached)
    for (let parent of fileInfo.parents) {
      let parentInfo;
      if (this.parentInfoCache.has(parent)) {
        parentInfo = this.parentInfoCache.get(parent);
      } else if (parent in this.fileInfo) {
        parentInfo = this.fileInfo[parent];
        this.parentInfoCache.set(parent, parentInfo);
      } else {
        // Fallback to individual fetch (should be rare)
        parentInfo = await this.getFileInfo(parent);
        if (parentInfo) {
          this.parentInfoCache.set(parent, parentInfo);
        }
      }
      
      for (let parentPath of await this.getPaths(parentInfo)) {
        ret.push(path.join(parentPath, fileInfo.name));
      }
    }

    return ret;
  }

  async getParent(src) {
    let dir = path.dirname(src);

    if (!(dir in this.paths)) {
      throw new Error("Unkown folder: ", dir);
    }

    return this.paths[dir];
  }

  /* Rename / move files appropriately to new destinations */
  async changePaths(oldPaths, newPaths) {
    if (oldPaths.length == 0) {
      debug("Can't change path, past path is empty");
      return;
    }

    let removedPaths = [];
    let addedPaths = [];

    // Convert to Sets for O(1) lookups instead of O(n²)
    const oldPathsSet = new Set(oldPaths);
    const newPathsSet = new Set(newPaths);

    for (let path of oldPaths) {
      if (!newPathsSet.has(path)) {
        removedPaths.push(path);
      }
    }

    for (let path of newPaths) {
      if (!oldPathsSet.has(path)) {
        addedPaths.push(path);
      }
    }

    for (let _path of addedPaths) {
      await mkdirp(path.dirname(_path));
    }

    for (let i = 0; i < removedPaths.length; i += 1) {
      if (i < addedPaths.length) {
        this.watcher.ignore(removedPaths[i]);
        this.watcher.ignore(addedPaths[i]);
        await fs.rename(removedPaths[i], addedPaths[i]);
        continue;
      }

      this.watcher.ignore(removedPaths[i]);
      await fs.remove(removedPaths[i]);
    }

    for (let i = removedPaths.length; i < addedPaths.length; i += 1) {
      this.watcher.ignore(addedPaths[i]);
      await fs.copy(newPaths[0], addedPaths[i]);
    }
  }

  isFolder(fileInfo) {
    return fileInfo.mimeType.includes("folder");
  }

  shouldIgnoreFile(fileInfo) {
    if (fileInfo.id == this.rootId) {
      return true;
    }
    if (this.isFolder(fileInfo)) {
      return false;
    }
    return !("size" in fileInfo);
  }

  async tryTwice(fn) {
    try {
      return await fn();
    } catch(err) {
      if (err.code != 'ECONNRESET') {
        throw err;
      }
    }

    error("Connection error received, waiting 2 seconds and retrying");
    await delay(2000);

    return await fn();
  }

  /* Batch get file info for multiple file IDs.
     Uses individual requests but fetches in parallel for efficiency.
     Returns a Map of fileId -> fileInfo (or null for 404s or errors) */
  async getFileInfoBatch(fileIds) {
    const results = new Map();
    
    // Filter out IDs already in cache
    const idsToFetch = fileIds.filter(id => !(id in this.fileInfo));
    
    if (idsToFetch.length === 0) {
      // All IDs are cached
      fileIds.forEach(id => results.set(id, this.fileInfo[id]));
      return results;
    }

    // Fetch all missing IDs in parallel with allSettled for partial success handling
    const fetchPromises = idsToFetch.map(async (fileId) => {
      try {
        const fileInfo = await this.getFileInfo(fileId);
        return { fileId, fileInfo, success: true };
      } catch (err) {
        // Handle 404s gracefully (consistent with getFileInfo)
        if (err.code == 404) {
          return { fileId, fileInfo: null, success: true };
        }
        // Log other errors but continue with batch
        error(`Failed to fetch file info for ${fileId}:`, err.message);
        return { fileId, fileInfo: null, success: false };
      }
    });

    const settledResults = await Promise.allSettled(fetchPromises);
    
    // Build results map from settled promises
    settledResults.forEach((result) => {
      if (result.status === 'fulfilled' && result.value.success) {
        const { fileId, fileInfo } = result.value;
        results.set(fileId, fileInfo);
      }
      // Rejected promises or unsuccessful fetches are skipped
    });
    
    // Add cached items to results
    fileIds.forEach(id => {
      if (!results.has(id) && id in this.fileInfo) {
        results.set(id, this.fileInfo[id]);
      }
    });

    return results;
  }

  /* Gets file info from fileId.

    If the file info is not present in cache or if forceUpdate is true,
    it seeks the information remotely and updates the cache as well. */
  async getFileInfo(fileId, forceUpdate) {
    if (!forceUpdate && (fileId in this.fileInfo)) {
      return this.fileInfo[fileId];
    }

    let getFileInfo = () => new Promise((resolve, reject) => {
      this.drive.files.get({fileId, fields: fileInfoFields}, (err, result) => {
        if (err) {
          return reject(err);
        }
        resolve(result);
      });
    });

    try {
      let fileInfo = await this.tryTwice(getFileInfo);

      return this.storeFileInfo(fileInfo);
    } catch (err) {
      /* File not existing on the other side */
      if (err.code == 404) {
        log("Unable to get requested file info for ", fileId);
        return null;
      }

      //Throw back other errors
      throw err;
    }
  }

  /* Utility function to only check in local memory */
  fileInfoFromPath(path) {
    if (!(path in this.paths)) {
      return null;
    }
    let id = this.paths[path];
    if (!(id in this.fileInfo)) {
      return null;
    }
    return this.fileInfo[id];
  }

  async storeFileInfo(info) {
    await this.computePaths(info);
    
    // Invalidate cache for this file's parent info since it may have changed
    if (info.parents) {
      for (let parent of info.parents) {
        this.parentInfoCache.delete(parent);
      }
    }
    
    return this.fileInfo[info.id] = info;
  }

  async computePaths(info) {
    if (info) {
      for (let path of await this.getPaths(info)) {
        this.paths[path] = info.id;
      }
    } else {
      debug("Computing empty paths");
      
      // Collect all parent IDs that will be needed
      const allParentIds = new Set();
      for (let info of Object.values(this.fileInfo)) {
        if (info.parents) {
          for (let parent of info.parents) {
            if (this._needsParentFetch(parent)) {
              allParentIds.add(parent);
            }
          }
        }
      }
      
      // Batch fetch all parent info upfront if there are any to fetch
      if (allParentIds.size > 0) {
        debug(`Batch fetching ${allParentIds.size} parent info entries`);
        const batchResults = await this.getFileInfoBatch(Array.from(allParentIds));
        batchResults.forEach((parentInfo, parentId) => {
          if (parentInfo) {
            this.parentInfoCache.set(parentId, parentInfo);
          }
        });
      }
      
      // Now compute paths for all files
      for (let info of Object.values(this.fileInfo)) {
        await this.computePaths(info);
      }
      debug("Paths computed", Object.keys(this.paths).length);
    }
  }

  async downloadFile(fileInfo) {
    verbose("Downlading file", fileInfo.name);
    if (this.shouldIgnoreFile(fileInfo)) {
      verbose("Ignoring file");
      return false;
    }
    await this.finishLoading();

    let savePaths = await this.getPaths(fileInfo);

    if (savePaths.length == 0) {
      return false;
    }

    /* If folder, just create the folder locally */
    if (this.isFolder(fileInfo)) {
      for (let path of savePaths) {
        this.watcher.ignore(path);
        await mkdirp(path);
      }
      return true;
    }

    let savePath = savePaths.shift();

    /* Create the folder for the file first */
    await mkdirp(path.dirname(savePath));

    let alreadyDownloaded = false;
    try {
      await fs.access(savePath);
      alreadyDownloaded = await md5file(savePath) == fileInfo.md5Checksum;
    } catch (err) {
      // File doesn't exist or can't be accessed
      alreadyDownloaded = false;
    }

    if (!alreadyDownloaded) {
      var tmpFile = path.join(this.account.folder, `.${fileInfo.name}.tmp`);
      var dest = fs.createWriteStream(tmpFile);

      await delay(80);

      verbose("Starting the actual download...");

      await this.tryTwice(() => new Promise((resolve, reject) => {
        this.watcher.ignore(savePath);
        this.drive.files.get({fileId: fileInfo.id, alt: "media"})
          .on('end', async () => {
            console.log('Done downloading file.');
            await fs.rename(tmpFile, savePath);
            resolve();
          })
          .on('error', err => reject(err))
          .pipe(dest);
      }).catch(async (err) => {
        /* Remove a partial download in case of err, don't want it to be synchronized later on */
        await fs.remove(tmpFile);
        throw err;
      }));
      log(`Downloaded ${fileInfo.name}!`);
    } else {
      log("File in local path with same md5 already existing");
    }

    for (let otherPath of savePaths) {
      verbose("Copying file to folder ", otherPath);
      this.watcher.ignore(otherPath);
      await fs.copy(savePath, otherPath);
    }

    return true;
  }

  async finishLoading() {
    while (!this.loaded) {
      await delay(20);
    }
  }

  async finishSaveOperation() {
    while (this.loading || this.saving) {
      await delay(20);
    }
  }

  async initWatcher() {
    //Queue system necessary because if a folder is added with files in it, the folder id is needed before uploading files, and it's gotten from google drive remotely
    //A more clever system would be needed to be more efficient
    const addListener = path => this.queue(() => this.onLocalFileAdded(path));
    const unlinkListener = path => this.queue(() => this.onLocalFileRemoved(path));
    const addDirListener = path => this.queue(() => this.onLocalDirAdded(path));
    const unlinkDirListener = path => this.queue(() => this.onLocalDirRemoved(path));
    const changeListener = path => this.queue(() => this.onLocalFileUpdated(path));

    this.watcher.on('add', addListener);
    this.watcher.on('unlink', unlinkListener);
    this.watcher.on('addDir', addDirListener);
    this.watcher.on('unlinkDir', unlinkDirListener);
    this.watcher.on('change', changeListener);

    // Store listeners as arrays per event for cleanup (supports multiple listeners per event)
    this.watcherListeners.set('add', [addListener]);
    this.watcherListeners.set('unlink', [unlinkListener]);
    this.watcherListeners.set('addDir', [addDirListener]);
    this.watcherListeners.set('unlinkDir', [unlinkDirListener]);
    this.watcherListeners.set('change', [changeListener]);
  }

  /* Loop function */
  async queue(fn) {
    debug("queuing function");
    this.queued.push(fn);

    debug("queue size", this.queued.length);
    //If queue is large, another loop is reading the queue
    if (this.queued.length > 1) {
      debug("Aborting");
      return;
    }

    try {
      while (this.queued.length > 0 && !this.closed) {
        this.handlingLocalChange = true;
        let f = this.queued[0];
        debug("Awaiting function end--->");
        await f();
        this.queued.shift();
        debug("<---Function ended");
      }
    } catch (err) {
      this.handlingLocalChange = false;
      throw err;
    }
    
    this.handlingLocalChange = false;
    debug("Queue end");
  }

  /* Load in NeDB */
  async load() {
    verbose("Beginning of loading sync object...");
    /* No reason to load a saving file or reload the file */
    if (this.loading || this.saving) {
      return await this.finishSaveOperation();
    }
    this.loading = true;

    try {
      verbose("Loading sync object");
      let obj = await globals.db.findOne({type: "sync", accountId: this.account.id});

      if (obj) {
        for (let item of toSave) {
          this[item] = obj[item] || this[item];
        }
        if (!this.loaded) {
          log("Local files registered: ", Object.keys(this.onLocalDrive).length);
        }

        this.id = obj._id;
      } else {
        verbose("Nothing to load");
      }
      verbose("Loaded sync object! ");

      //Compute paths
      if (this.fileInfo) {
        await this.computePaths();
      }

      //Load changes that might have not gotten throughs
      this.loaded = true;

      this.watcher.init();
      await this.handleChanges();

      if (obj && obj.synced) {
        this.watchChanges();
      }
      this.loading = false;
    } catch (err) {
      this.loading = false;
      this.handlingRemoteChange = false;
      throw err;
    }
  }

  /* Save in NeDB, overwriting previous entry */
  async save() {
    verbose("Saving sync object");
    await this.finishLoading();

    if (this.loading || this.saving) {
      return await this.finishSaveOperation();
    }
    this.saving = true;

    try {
      if (!this.id) {
        //Create new object
        let obj = await globals.db.insert({type: "sync", accountId: this.account.id});
        this.id = obj._id;
      }

      /* Save object */
      let saveObject = {
        type: "sync",
        accountId: this.account.id,
        _id: this.id
      };

      for (let item of toSave) {
        saveObject[item] = this[item];
      }

      await globals.db.update({_id: this.id}, saveObject, {});
      this.savedTime = Date.now();
      this.changesSinceSave = 0;
      verbose("Saved new synchronization changes!");

      this.watchChanges();
      this.saving = false;
    } catch(err) {
      this.saving = false;
      throw err;
    }
  }

  async erase() {
    verbose("Erasing sync object");
    await this.close();
    await this.finishLoading();

    if (this.loading || this.saving) {
      return await this.finishSaveOperation();
    }
    this.saving = true;

    try {
      if (this.id) {
        await globals.db.remove({type: "sync", accountId: this.account.id});
      }
      this.saving = false;
    } catch(err) {
      this.saving = false;
      throw err;
    }
  }
}

module.exports = Sync;
