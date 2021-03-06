var express = require('express')
var bodyParser = require('body-parser')
var cookieParser = require('cookie-parser')
var expressValidator = require('express-validator')
var RateLimit = require('express-rate-limit')
var vhost = require('vhost')

var Hypercloud = require('./lib')
var customValidators = require('./lib/validators')
var customSanitizers = require('./lib/sanitizers')
var packageJson = require('./package.json')

module.exports = function (config) {
  var cloud = new Hypercloud(config)
  cloud.version = packageJson.version
  cloud.setupAdminUser()

  var app = express()
  app.cloud = cloud
  app.config = config

  app.locals = {
    session: false, // default session value
    errors: false, // common default value
    appInfo: {
      version: packageJson.version,
      brandname: config.brandname,
      hostname: config.hostname,
      port: config.port
    }
  }

  app.use(cookieParser())
  app.use(bodyParser.json())
  app.use(bodyParser.urlencoded())
  app.use(expressValidator({ customValidators, customSanitizers }))
  app.use(cloud.sessions.middleware())
  if (config.rateLimiting) {
    app.use(new RateLimit({windowMs: 1e3, max: 100, delayMs: 0})) // general rate limit
    app.use('/v1/verify', actionLimiter(24, 'Too many accounts created from this IP, please try again after an hour'))
    app.use('/v1/login', actionLimiter(1, 'Too many login attempts from this IP, please try again after an hour'))
  }

  // http gateway
  // =

  if (config.sites) {
    var httpGatewayApp = express()
    httpGatewayApp.get('/.well-known/dat', cloud.api.archiveFiles.getDNSFile)
    if (config.sites === 'per-archive') {
      httpGatewayApp.get('*', cloud.api.archiveFiles.getFile)
      app.use(vhost('*.*.' + config.hostname, httpGatewayApp))
      app.use(vhost('*.' + config.hostname, httpGatewayApp))
    } else {
      httpGatewayApp.get('*', cloud.api.archiveFiles.getFile)
      app.use(vhost('*.' + config.hostname, httpGatewayApp))
    }
  }

  // service apis
  // =

  app.get('/', cloud.api.service.frontpage)
  app.get('/v1/explore', cloud.api.service.explore)

  // user & auth apis
  // =

  app.post('/v1/register', cloud.api.users.doRegister)
  app.all('/v1/verify', cloud.api.users.verify)
  app.get('/v1/account', cloud.api.users.getAccount)
  app.post('/v1/account', cloud.api.users.updateAccount)
  app.post('/v1/account/password', cloud.api.users.updateAccountPassword)
  app.post('/v1/login', cloud.api.users.doLogin)
  app.get('/v1/logout', cloud.api.users.doLogout)
  app.post('/v1/forgot-password', cloud.api.users.doForgotPassword)
  app.get('/v1/users/:username([^/]{3,})', cloud.api.users.get)

  // archives apis
  // =

  app.post('/v1/archives/add', cloud.api.archives.add)
  app.post('/v1/archives/remove', cloud.api.archives.remove)
  app.get('/v1/archives/:key([0-9a-f]{64})', cloud.api.archives.get)
  app.get('/v1/users/:username([^/]{3,})/:archivename', cloud.api.archives.getByName)

  // admin apis
  // =

  app.get('/v1/admin/users', cloud.api.admin.listUsers)
  app.get('/v1/admin/users/:id', cloud.api.admin.getUser)
  app.post('/v1/admin/users/:id', cloud.api.admin.updateUser)
  app.post('/v1/admin/users/:id/suspend', cloud.api.admin.suspendUser)
  app.post('/v1/admin/users/:id/unsuspend', cloud.api.admin.unsuspendUser)

  // (json) error-handling fallback
  // =

  app.use((err, req, res, next) => {
    var contentType = req.accepts('json')
    if (!contentType) {
      return next()
    }

    // validation errors
    if ('isEmpty' in err) {
      return res.status(422).json({
        message: 'There were errors in your submission',
        invalidInputs: true,
        details: err.mapped()
      })
    }

    // common errors
    if ('status' in err) {
      res.status(err.status)
      res.json(err.body)
      return
    }

    // general uncaught error
    console.error('[ERROR]', err)
    res.status(500)
    var error = {
      message: 'Internal server error',
      internalError: true
    }
    res.json(error)
  })

  // ui module handlers
  // =

  if (config.ui) {
    app.use(require(config.ui)({cloud, config}))
  }

  // error handling
  // =

  process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason)
  })

  // shutdown
  // =

  app.close = cloud.close.bind(cloud)

  return app
}

function actionLimiter (perHour, message) {
  return new RateLimit({
    windowMs: perHour * 60 * 60 * 1000,
    delayMs: 0,
    max: 5, // start blocking after 5 requests
    message
  })
}
