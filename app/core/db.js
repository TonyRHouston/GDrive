const Datastore = require('@seald-io/nedb');

class DataStore {
  constructor(options) {
    this._db = new Datastore({
      filename: options.filename,
      autoload: options.autoload
    });

    if (options.autoCompactionInterval) {
      this._db.persistence.setAutocompactionInterval(options.autoCompactionInterval);
    }
  }

  loadDatabase() {
    return new Promise((resolve, reject) => {
      this._db.loadDatabase(err => err ? reject(err) : resolve());
    });
  }

  find(query) {
    return new Promise((resolve, reject) => {
      this._db.find(query, (err, docs) => err ? reject(err) : resolve(docs));
    });
  }

  findOne(query) {
    return new Promise((resolve, reject) => {
      this._db.findOne(query, (err, doc) => err ? reject(err) : resolve(doc));
    });
  }

  insert(doc) {
    return new Promise((resolve, reject) => {
      this._db.insert(doc, (err, newDoc) => err ? reject(err) : resolve(newDoc));
    });
  }

  update(query, update, options = {}) {
    return new Promise((resolve, reject) => {
      this._db.update(query, update, options, (err, numAffected) => err ? reject(err) : resolve(numAffected));
    });
  }

  remove(query, options = {}) {
    return new Promise((resolve, reject) => {
      this._db.remove(query, options, (err, numRemoved) => err ? reject(err) : resolve(numRemoved));
    });
  }
}

module.exports = DataStore;
