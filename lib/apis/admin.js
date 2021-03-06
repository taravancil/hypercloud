const {NotFoundError, UnauthorizedError, ForbiddenError} = require('../const')

// exported api
// =

module.exports = class AdminAPI {
  constructor (cloud) {
    this.usersDB = cloud.usersDB
  }

  async listUsers (req, res) {
    // check perms
    if (!res.locals.session) throw new UnauthorizedError()
    if (!res.locals.session.scopes.includes('admin:users')) throw new ForbiddenError()

    // fetch
    var users = await this.usersDB.list({
      cursor: req.query.cursor,
      limit: req.query.limit ? +req.query.limit : 25,
      sort: req.query.sort,
      reverse: +req.query.reverse === 1
    })

    // respond
    res.status(200)
    res.json({users})
  }

  async getUser (req, res) {
    // check perms
    if (!res.locals.session) throw new UnauthorizedError()
    if (!res.locals.session.scopes.includes('admin:users')) throw new ForbiddenError()

    // fetch
    var user = await this._getUser(req.params.id)

    // respond
    res.status(200)
    res.json(user)
  }

  async updateUser (req, res) {
    // check perms
    if (!res.locals.session) throw new UnauthorizedError()
    if (!res.locals.session.scopes.includes('admin:users')) throw new ForbiddenError()

    // validate & sanitize input
    req.checkBody('username').optional()
      .isAlphanumeric().withMessage('Can only be letters and numbers.')
      .isLength({ min: 3, max: 16 }).withMessage('Must be 3 to 16 characters.')
    req.checkBody('email', 'Must be a valid email').optional()
      .isEmail()
      .isLength({ min: 3, max: 100 })
    req.checkBody('scopes', 'Must be an array of strings.').optional()
      .isScopesArray()
    ;(await req.getValidationResult()).throw()
    var { username, email, scopes } = req.body

    // fetch
    var user = await this._getUser(req.params.id)

    // update
    if (typeof username !== 'undefined') user.username = username
    if (typeof email !== 'undefined') user.email = email
    if (typeof scopes !== 'undefined') user.scopes = scopes
    await this.usersDB.put(user)

    // respond
    res.status(200)
    res.json(user)
  }

  async suspendUser (req, res) {
    // check perms
    if (!res.locals.session) throw new UnauthorizedError()
    if (!res.locals.session.scopes.includes('admin:users')) throw new ForbiddenError()

    // fetch user record
    var user = await this._getUser(req.params.id)

    // update record
    var scopeIndex = user.scopes.indexOf('user')
    if (scopeIndex !== -1) user.scopes.splice(scopeIndex, 1)
    user.suspension = req.body && req.body.reason ? req.body.reason : true
    await this.usersDB.put(user)

    // respond
    res.status(200).end()
  }

  async unsuspendUser (req, res) {
    // check perms
    if (!res.locals.session) throw new UnauthorizedError()
    if (!res.locals.session.scopes.includes('admin:users')) throw new ForbiddenError()

    // fetch user record
    var user = await this._getUser(req.params.id)

    // update record
    var scopeIndex = user.scopes.indexOf('user')
    if (scopeIndex === -1) user.scopes.push('user')
    user.suspension = null
    await this.usersDB.put(user)

    // respond
    res.status(200).end()
  }

  async _getUser (id) {
    // try to fetch by id, username, and email
    var user = await this.usersDB.getByID(id)
    if (user) return user

    user = await this.usersDB.getByUsername(id)
    if (user) return user

    user = await this.usersDB.getByEmail(id)
    if (user) return user

    throw new NotFoundError()
  }
}
