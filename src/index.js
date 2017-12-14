'use strict';

var Promise = require('bluebird');
var request = require('request-promise');
var dbUtil = require('metisoft-database-util');
var DatabaseConnection = dbUtil.DatabaseConnection;
var dbc;
var dbu = dbUtil.databaseUtil;

/**
 * A middleware layer that verifies the Facebook access token given in
 * the request. If valid, it will supply data to `req` that subsequent
 * middleware functions can use.
 *
 * @module server/util/facebookAuth
 */



var __mapAccessToken2UserData = {};



/**
 * @typedef InternalUserData
 * @type Object
 * @memberof module:server/util/facebookAuth
 *
 * @property {String} id
 * @property {String} facebookId
 * @property {String} email
 * @property {String} fullName
 */

/**
 * Retrieves the user data object that is mapped to from the access token.
 * If user data hasn't already been stored for this access token, this
 * function queries Facebook to see if the token is valid. If so, it will
 * store the user data for later retrieval.
 *
 * @private
 * @memberof module:server/util/facebookAuth
 * @param {String} accessToken
 * @returns {Promise<module:server/util/facebookAuth~InternalUserData|null>}
 */
function __getUserDataFromAccessToken(accessToken) {
  if (__mapAccessToken2UserData.hasOwnProperty(accessToken)) {
    return Promise.resolve(__mapAccessToken2UserData[accessToken]);
  
  } else {
    return __getUserDataFromFacebook(accessToken)
      
      .then(function(userDataFromFacebook) {
        var internalUserData = null;
        userDataFromFacebook = JSON.parse(userDataFromFacebook);

        if (__isValidFacebookUserData(userDataFromFacebook)) {
          internalUserData = __formatUserDataAsInternal(userDataFromFacebook);
          return __saveUserToDb(internalUserData);
        } else {
          return null;
        }
      })

      .then(function(userData) {
        if (userData !== null) {
          __mapAccessToken2UserData[accessToken] = userData;
          return userData;
        } else {
          return null;
        }
      })

      .catch(function(err) {
        console.error(err);
        return null;
      });
  }
}



/**
 * This function sends an HTTP request to Facebook's Graph API to get
 * information about the user associated with the given access token.
 * It just returns the response and doesn't do any checks to see whether
 * the response indicates an error or invalid token.
 *
 * @private
 * @memberof module:server/util/facebookAuth
 * @param {String} accessToken
 * @returns {Promise<FacebookResponse>}
 */
function __getUserDataFromFacebook(accessToken) {
  var options = {
        url: 'https://graph.facebook.com/v2.10/me?fields=id,name,email',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'OAuth ' + accessToken
        }
      };

  return request(options);
}



/**
 * Examines the response from Facebook and returns `true` if valid user
 * data exists in it.
 *
 * @private
 * @memberof module:server/util/facebookAuth
 * @param {String} facebookUserData
 * @returns {Boolean}
 */
function __isValidFacebookUserData(facebookUserData) {
  return (
    facebookUserData.hasOwnProperty('id') &&
    facebookUserData.hasOwnProperty('name') &&
    facebookUserData.hasOwnProperty('email')
  );
}



/**
 * Takes a valid user data object from the Facebook Graph API response
 * and converts it to an internal format.
 *
 * @private
 * @memberof module:server/util/facebookAuth
 * @param {Object} facebookUserData
 * @returns {module:server/util/facebookAuth~InternalUserData}
 */
function __formatUserDataAsInternal(facebookUserData) {
  var internalUserData = {};

  internalUserData.facebookId = facebookUserData.id;
  internalUserData.fullName = facebookUserData.name;
  internalUserData.email = facebookUserData.email;

  return internalUserData;
}



/**
 * This function assumes a valid user data object and looks up the user
 * in the database. If they don't have an entry in the database, one is
 * added. Either way, an object representing the user is returned.
 *
 * @private
 * @memberof module:server/util/facebookAuth
 * @param {module:server/util/facebookAuth~InternalUserData} userData
 * @returns {module:server/util/facebookAuth~InternalUserData}
 */
function __saveUserToDb(userData) {
  return __getUserFromDb(userData.facebookId)

    .then(function(user) {
      if (!user.id) {
        return __addUserToDb(userData);
      } else {
        return user;
      }
    });
}



/**
 * This function looks up the user in the database using that user's Facebook
 * ID.
 *
 * @private
 * @memberof module:server/util/facebookAuth
 * @param {String} facebookId
 * @returns {module:server/util/facebookAuth~InternalUserData}
 */
function __getUserFromDb(facebookId) {
  var query;

  query = dbc.getSquelSelect().from('site_user')
    .field('id')
    .field('facebook_user_id', 'facebookId')
    .field('email')
    .field('full_name', 'fullName')

    .where('facebook_user_id = ?', facebookId)
    .limit(1);

  return dbc.squelQueryReturningOne(query.toParam());
}



/**
 * This function adds an entry for the given user to our database.
 *
 * @private
 * @memberof module:server/util/facebookAuth
 * @param {module:server/util/facebookAuth~InternalUserData} userData
 *
 * @returns {module:server/util/facebookAuth~InternalUserData|null}
 *    Returns the user object, or `null` if an error occurred.
 */
function __addUserToDb(userData) {
  var query;

  query = dbc.getSquelInsert().into('site_user')
    .set('facebook_user_id', userData.facebookId)
    .set('email', userData.email)
    .set('full_name', userData.fullName)
    .returning('id');

  return dbc.squelQueryReturningOne(query.toParam())

    .then(function(row) {
      userData.id = row.id;
      return userData;
    })

    .catch(function(err) {
      console.error(err);
      return null;
    });
}



/**
 * The middleware function that verifies the access token found in `req.session.facebookAccessToken`.
 * If not found there, it will look in `req.facebookAccessToken`, which
 * is what should be used when first logging in with the app with Facebook.
 * If it is a valid token, `res.locals.metisoft.user.facebookId`, `res.locals.metisoft.user.email`,
 * and `res.locals.metisoft.user.fullName` will be populated after this call.
 * `req.session.facebookAccessToken` will also be populated if the token is
 * valid.
 *
 * @public
 * @memberof module:server/util/facebookAuth
 * @param {Request} req
 * @param {Response} res
 * @param {Next} next
 */
function facebookAuthMiddleware(req, res, next) {
  var userData = null,
      accessToken;

  if (req.body && req.body.facebookAccessToken) {
    accessToken = req.body.facebookAccessToken;
  } else if (req.session && req.session.user && req.session.user.facebookAccessToken) {
    accessToken = req.session.user.facebookAccessToken;
  }

  if (__isLogoutRoute(req.url)) {
    delete __mapAccessToken2UserData[accessToken];
    req.session.destroy();
    accessToken = '';
    next();
  
  } else if (accessToken) {
    __getUserDataFromAccessToken(accessToken)
      
      .then(function(userData) {
        if (!userData) {
          throw new Error('LOGIN_REQUIRED');
        }

        res.locals = res.locals || {};
        res.locals.metisoft = res.locals.metisoft || {};
        res.locals.metisoft.user = res.locals.metisoft.user || {};

        res.locals.metisoft.user.id = userData.id;
        res.locals.metisoft.user.facebookId = userData.facebookId;
        res.locals.metisoft.user.email = userData.email;
        res.locals.metisoft.user.fullName = userData.fullName;

        if (req.session) {
          req.session.user = req.session.user || {};
          req.session.user.facebookAccessToken = accessToken;
          req.session.save(function(error) {
            if (error) {
              console.error(error);
            }
          });
        }

        next();
      })

      .catch(function(err) {
        console.error(err);

        if (req.session && req.session.user) {
          delete req.session.user;
        }

        res.send({
          error: 'LOGIN_REQUIRED'
        });
        res.end();
      })
  
  } else {
    if (req.session && req.session.user) {
      delete req.session.user;
    }

    res.send({
      error: 'LOGIN_REQUIRED'
    });
    res.end();
  }
}



function __isLogoutRoute(url) {
  return (url === '/services/userAuth/logout');
}



/**
 * Configures the middleware to use a particular database when looking
 * up users.
 *
 * @private
 * @memberof module:server/util/facebookAuth
 * @param {DatabaseConfig} databaseConfig
 */
function config(databaseConfig) {
  dbc = DatabaseConnection.getConnection(databaseConfig.connection.database, '', databaseConfig);
}



module.exports = exports = {
  config: config,
  facebookAuthMiddleware: facebookAuthMiddleware
};