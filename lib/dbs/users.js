var assert = require('assert')
var monotonicTimestamp = require('monotonic-timestamp')
var levelPromise = require('level-promise')
var createIndexer = require('level-simple-indexes')
var sublevel = require('subleveldown')
var collect = require('stream-collector')
var EventEmitter = require('events')
var { promisifyModule } = require('../helpers')
var lock = require('../lock')

// exported api
// =

class UsersDB extends EventEmitter {
  constructor (cloud) {
    super()
    // create levels and indexer
    this.accountsDB = sublevel(cloud.db, 'accounts', { valueEncoding: 'json' })
    this.indexDB = sublevel(cloud.db, 'accounts-index')
    this.indexer = createIndexer(this.indexDB, {
      keyName: 'id',
      properties: ['email', 'username', 'profileURL'],
      map: (id, next) => {
        this.getByID(id)
          .catch(next)
          .then(res => next(null, res))
      }
    })

    // promisify
    levelPromise.install(this.accountsDB)
    levelPromise.install(this.indexDB)
    promisifyModule(this.indexer, ['findOne', 'addIndexes', 'removeIndexes', 'updateIndexes'])
  }

  // basic ops
  // =

  async create (record) {
    assert(record && typeof record === 'object')
    record = Object.assign({}, UsersDB.defaults, record)
    record.id = monotonicTimestamp().toString(36)
    record.createdAt = Date.now()
    await this.put(record)
    this.emit('create', record)
    return record
  }

  async put (record) {
    assert(typeof record.id === 'string')
    var release = await lock('users:write:' + record.id)
    try {
      record.updatedAt = Date.now()
      await this.accountsDB.put(record.id, record)
      await this.indexer.updateIndexes(record)
    } finally {
      release()
    }
    this.emit('put', record)
  }

  async del (record) {
    assert(typeof record.id === 'string')
    var release = await lock('users:write:' + record.id)
    try {
      await this.accountsDB.del(record.id)
      await this.indexer.removeIndexes(record)
    } finally {
      release()
    }
    this.emit('del', record)
  }

  // getters
  // =
  // TODO
  // do these getters need to be put behind locks along w/the rights?
  // the index-based reads (email, username) involve 2 separate reads, not atomic
  // -prf

  async isEmailTaken (email) {
    var record = await this.getByEmail(email)
    return !!record
  }

  async isUsernameTaken (username) {
    var record = await this.getByUsername(username)
    return !!record
  }

  async getByID (id) {
    assert(typeof id === 'string')
    try {
      return await this.accountsDB.get(id)
    } catch (e) {
      if (e.notFound) return null
      throw e
    }
  }

  async getByEmail (email) {
    assert(typeof email === 'string')
    return this.indexer.findOne('email', email)
  }

  async getByUsername (username) {
    assert(typeof username === 'string')
    return this.indexer.findOne('username', username)
  }

  async getByProfileURL (profileURL) {
    assert(typeof profileURL === 'string')
    return this.indexer.findOne('profileURL', profileURL)
  }

  list ({cursor, limit, reverse, sort}) {
    return new Promise((resolve, reject) => {
      var opts = {limit, reverse}
      // find indexes require a start- and end-point
      if (sort && sort !== 'id') {
        if (reverse) {
          opts.lt = cursor || '\xff'
          opts.gte = '\x00'
        } else {
          opts.gt = cursor || '\x00'
          opts.lte = '\xff'
        }
      } else if (typeof cursor !== 'undefined') {
        // set cursor according to reverse
        if (reverse) opts.lt = cursor
        else opts.gt = cursor
      }
      // fetch according to sort
      var stream
      if (sort === 'username') stream = this.indexer.find('username', opts)
      else if (sort === 'email') stream = this.indexer.find('email', opts)
      else stream = this.accountsDB.createValueStream(opts)
      // collect into an array
      collect(stream, (err, res) => {
        if (err) reject(err)
        else resolve(res)
      })
    })
  }

  // highlevel updates
  // =

  async addArchive (userId, archiveKey, name) {
    var release = await lock('users:update:' + userId)
    try {
      // fetch/create record
      var userRecord = await this.getByID(userId)

      // add/update archive
      var archive = userRecord.archives.find(a => a.key === archiveKey)
      if (!archive) {
        archive = Object.assign({}, UsersDB.archiveDefaults)
        archive.key = archiveKey
        if (typeof name !== 'undefined') archive.name = name
        userRecord.archives.push(archive)
      } else {
        if (typeof name !== 'undefined') archive.name = name
      }

      // update records
      await this.put(userRecord)
    } finally {
      release()
    }
    this.emit('add-archive', {userId, archiveKey, name}, userRecord)
  }

  async removeArchive (userId, archiveKey) {
    var release = await lock('users:update:' + userId)
    try {
      // fetch/create record
      var userRecord = await this.getByID(userId)

      // remove archive
      var index = userRecord.archives.findIndex(a => a.key === archiveKey)
      if (index === -1) {
        return // not already hosting
      }
      userRecord.archives.splice(index, 1)

      // update records
      await this.put(userRecord)
    } finally {
      release()
    }
    this.emit('remove-archive', {userId, archiveKey}, userRecord)
  }
}
module.exports = UsersDB

// default user-record values
UsersDB.defaults = {
  username: null,
  passwordHash: null,
  passwordSalt: null,

  email: null,
  profileURL: null,
  scopes: [],
  suspension: null,
  archives: [],
  updatedAt: 0,
  createdAt: 0,

  isEmailVerified: false,
  emailVerifyNonce: null,

  forgotPasswordNonce: null,

  isProfileDatVerified: false,
  profileVerifyToken: null
}

// default user-record archive values
UsersDB.archiveDefaults = {
  key: null,
  name: null
}
