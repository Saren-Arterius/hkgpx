#!/usr/bin/env node

var restify = require('restify');
var env = require('jsdom').env;
var request = require('request');
var fs = require('fs');
var path = require('path');
var md5 = require('MD5');
var zlib = require('zlib');

// ======= CHANGE THINGS BELOW =======
var BIND_ADDRESS = process.env.OPENSHIFT_NODEJS_IP || "0.0.0.0";
var SERVER_PORT = process.env.OPENSHIFT_NODEJS_PORT || process.env.PORT || 8888; // http://127.0.0.1:8888

var POSTS_PER_PAGE = 25; // Do not change
var SAVE_MIN_INTERVAL = 5 * 1000; // There will be at least 5 seconds between DB and logs saving
var CLEANUP_INTERVAL = 600 * 1000; // Clean up unverified accounts && unused long topic cache
var HKGOLDEN_CACHE_TIME = 60 * 1000 // Topic list && dynamic topic page cache time &&
var HKGOLDEN_LONG_CACHE_TIME = 3 * 3600 * 1000; // If a topic page contains at least 25 replies, it is long cache
/*
 * How frequent can an IP create new account / verify an account in a period
 * It also counts if an IP requests with non-existence account or wrong token to prevent bruce-force.
 */
var ACCOUNT_ACTION_RATE_LIMIT_TIMES = 10;
/*
 * How frequent can a user make this server request to HKGolden server in a period
 * It does not count when the user's request has hit the cache.
 */
var API_ACCESS_RATE_LIMIT_TIMES = 50;

var FRIEND_USER_IDS = [505042]; // Friends does not have rate limit
var FRIEND_ONLY_SERVER = false; // true: Only friends can create a new account here
var NO_CACHE_FRIEND_REQUESTS = true; // Do not respond friend's request with short cache (long cache ok) (?cache=true to bypass)

// This is to prevent the server from triggering HKGolden's rate limit system to block ourself out.
var REQUEST_MIN_INTERVALS = {
  "hkg_desktop": 2 * 1000, // There will be at least 2 seconds between each request to http://forum15.hkgolden.com
  "hkg_api": 1 * 1000, // There will be at least 1 seconds between each request to HKGolden mobile API
};

// How frequent will rate limits reset
var RATE_LIMIT_RESET_INTERVALS = {
  "account_action": 180 * 1000,
  "hkg_access": 300 * 1000
};

var VALID_FORUMS = ["ET", "CA", "FN", "GM", "HW", "IN", "SW", "MP", "AP",
  "SP", "LV", "SY", "ED", "BB", "PT", "TR", "CO", "AN", "TO", "MU", "VI",
  "DC", "ST", "WK", "TS", "RA", "MB", "AC", "JT", "EP", "BW"
];
// ======= CHANGE THINGS ABOVE =======

var pingTime = -1;

// Misc functions
Date.prototype.yyyymmdd = function() {
  var yyyy = this.getFullYear().toString();
  var mm = (this.getMonth() + 1).toString(); // getMonth() is zero-based
  var dd = this.getDate().toString();
  return yyyy + (mm[1] ? mm : "0" + mm[0]) + (dd[1] ? dd : "0" + dd[0]); // padding
};

String.prototype.format = function() {
  var i = 0,
    args = arguments;
  return this.replace(/{}/g, function() {
    return typeof args[i] != 'undefined' ? args[i++] : '';
  });
};

var isInt = function(value) {
  return !isNaN(value) &&
    parseInt(Number(value)) == value &&
    !isNaN(parseInt(value, 10));
}

var checkInt = function(value, varName, res) {
  if (!isInt(value)) {
    res.send(400, "{} must be integer.".format(varName));
    return true;
  }
  if (parseInt(value) <= 0) {
    res.send(400, "{} must be greater than 0.".format(varName));
    return true;
  }
  return false;
}

var checkAPIRequest = function(req, res) {
  if (req.params.private_token.length != 32) {
    res.send(400, "Private token's length must be 32.");
    return true;
  }
  if (!(req.params.id in db["accounts"])) {
    res.send(400, "Account does not exist.");
    return true;
  }
  if (!db["accounts"][req.params.id]["verified"]) {
    res.send(400, "Account is not yet verified.");
    return true;
  }
  if (!checkRateLimit("account_action", req.headers["x-real-ip"], 10, false)) {
    res.send(429, "Rate limit exceeded.");
    return;
  }
  if (req.params.private_token !== db["accounts"][req.params.id]["private_token"]) {
    res.send(400, "Private token mismatch.");
    checkRateLimit("account_action", req.headers["x-real-ip"], 10, true);
    return true;
  }
  return false;
}

var makeID = function() {
  var text = "";
  var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  for (var i = 0; i < 32; i++)
    text += possible.charAt(Math.floor(Math.random() * possible.length));

  return text;
}

var apiKey = function(userID) {
  return md5("{}_HKGOLDEN_{}_$API#1.3^".format(new Date().yyyymmdd(), userID));
}

// functionNextRun
var functionNextRun = {};
for (var field in REQUEST_MIN_INTERVALS) {
  functionNextRun[field] = 0;
}

var delayedFunctionRun = function(field, func) {
  var now = Date.now();
  if (functionNextRun[field] < now) {
    functionNextRun[field] = now;
  }
  var wait = functionNextRun[field] - now;
  if (wait > 0) {
    console.log("Will wait {} before running {}".format(wait, field));
  }
  setTimeout(func, wait);
  functionNextRun[field] += REQUEST_MIN_INTERVALS[field];
}

// DB
var dbFilename = path.join(__dirname, "db.gz");
var dbFilenameJson = path.join(__dirname, "db.json");
var lastSaveDb = 0;

var saveDb = function() {
  if (Date.now() - lastSaveDb < SAVE_MIN_INTERVAL) {
    return;
  }

  lastSaveDb = Date.now();
  try {
    fs.writeFile(dbFilename, zlib.gzipSync(JSON.stringify(db)), function(err) {
      if (err) {
        return console.log(err);
      }
    })
  } catch (e) {
    fs.writeFile(dbFilenameJson, JSON.stringify(db), function(err) {
      if (err) {
        return console.log(err);
      }
    })
  }
};

var db;
try {
  db = JSON.parse(zlib.gunzipSync(fs.readFileSync(dbFilename)));
} catch (e) {
  try {
    db = JSON.parse(fs.readFileSync(dbFilenameJson));
  } catch (e) {
    var db = {
      "rate_limit": {},
      "accounts": {},
      "long_cache": {},
    };
  }
} finally {
  saveDb();
}

// log
var logsPath = path.join(__dirname, "logs");
var getLogFilename = function() {
  return path.join(logsPath, "{}.json".format(new Date().yyyymmdd()));
}
var logLastFileName = getLogFilename();
var lastSaveLog = 0;

var saveLog = function() {
  if (Date.now() - lastSaveLog < SAVE_MIN_INTERVAL) {
    return;
  }
  lastSaveLog = Date.now();
  var lfn = getLogFilename();
  fs.writeFile(lfn, JSON.stringify(log), function(err) {
    if (err) {
      return console.log(err);
    }
  });
  if (lfn != logLastFileName) {
    log = {
      "raw_requests": []
    };
  }
  logLastFileName = lfn;
};

if (!fs.existsSync(logsPath)) {
  fs.mkdirSync(logsPath);
}


try {
  var log = JSON.parse(fs.readFileSync(getLogFilename()));
} catch (e) {
  var log = {
    "raw_requests": [],
  };
} finally {
  saveLog();
}

// Topic list / Temp topic cache
var caches = {};
var pendingResponses = {};
var addPendingResponse = function(cacheKey, res) {
  if (!(cacheKey in pendingResponses)) {
    pendingResponses[cacheKey] = [];
  }
  pendingResponses[cacheKey].push(res);
  return pendingResponses[cacheKey].length == 1;
}
var sendToAllResponses = function(cacheKey, responseCode, body) {
  for (var i in pendingResponses[cacheKey]) {
    var pRes = pendingResponses[cacheKey][i];
    pRes.send(responseCode, body);
  }
  pendingResponses[cacheKey] = [];
}

// Rate limit system
var resetRateLimit = function(field) {
  db["rate_limit"][field] = {};
}

var checkRateLimit = function(field, key, max, add) {
  if (!(field in db["rate_limit"])) {
    resetRateLimit(field);
  }
  if (!(key in db["rate_limit"][field])) {
    db["rate_limit"][field][key] = 1;
    saveDb();
    console.log("({}) {}: {}".format(field, key, db["rate_limit"][field][key]));
    return true;
  }
  if (db["rate_limit"][field][key] + 1 > max) {
    return false;
  }
  if (add) {
    db["rate_limit"][field][key]++;
    saveDb();
    console.log("({}) {}: {}".format(field, key, db["rate_limit"][field][key]));
  }
  return true;
}

for (var key in RATE_LIMIT_RESET_INTERVALS) {
  (function(key) {
    resetRateLimit(key);
    setInterval(function() {
      resetRateLimit(key);
    }, RATE_LIMIT_RESET_INTERVALS[key]);
  })(key);
}

// Unverified ac cleanup, also cleans untouched long cache
setInterval(function() {
  var now = Date.now();
  var modified = false;
  for (var id in db["accounts"]) {
    if (db["accounts"][id]["verified"]) {
      if ("destroy_if_not_verified_after" in db["accounts"][id]) {
        modified = true;
        delete db["accounts"][id]["destroy_if_not_verified_after"];
      }
      continue;
    }
    if (db["accounts"][id]["destroy_if_not_verified_after"] > now) {
      continue;
    }
    modified = true;
    delete db["accounts"][id];
  }
  for (var cacheKey in db["long_cache"]) {
    if (db["long_cache"][cacheKey]["expires"] > now) {
      continue;
    }
    modified = true;
    delete db["long_cache"][cacheKey];
  }
  if (modified) {
    saveDb();
  }
}, CLEANUP_INTERVAL);


env("", function(errors, window) {
  var $ = require('jquery')(window);
  var server = restify.createServer({
    name: "HKGPX"
  });

  server.get('/ping', function(req, res, next) {
    res.send({"download_time": pingTime});
  });

  server.put('/new-account/:id/:private_token', function(req, res, next) {
    res.charSet('utf-8');
    if (checkInt(req.params.id, "ID", res)) {
      return;
    }
    if (req.params.private_token.length != 32) {
      res.send(400, "Private token's length must be 32.");
      return;
    }
    if (!checkRateLimit("account_action", req.headers["x-real-ip"], 10, true)) {
      res.send(429, "Rate limit exceeded.");
      return;
    }
    if (FRIEND_ONLY_SERVER && FRIEND_USER_IDS.indexOf(parseInt(req.params.id)) === -1) {
      res.send(403, "Only friends can create a new account.");
      return;
    }

    var publicToken = makeID();
    if (req.params.id in db["accounts"]) {
      db["accounts"][req.params.id]["pending_private_token"] = req.params.private_token;
      db["accounts"][req.params.id]["public_token"] = publicToken;
    } else {
      var account = {
        "pending_private_token": req.params.private_token,
        "public_token": publicToken,
        "private_token": null,
        "verified": false,
        "destroy_if_not_verified_after": Date.now() + CLEANUP_INTERVAL
      }
      db["accounts"][req.params.id] = account;
    }
    res.send({
      "id": req.params.id,
      "private_token": req.params.private_token,
      "public_token": publicToken
    });
    saveDb();
  });

  server.post('/verify-account/:id/:private_token', function(req, res, next) {
    res.charSet('utf-8');
    if (checkInt(req.params.id, "ID", res)) {
      return;
    }
    if (req.params.private_token.length != 32) {
      res.send(400, "Private token's length must be 32.");
      return;
    }
    if (!checkRateLimit("account_action", req.headers["x-real-ip"], 10, true)) {
      res.send(429, "Rate limit exceeded.");
      return;
    }
    if (!(req.params.id in db["accounts"])) {
      res.send(400, "Account does not exist.");
      return;
    }
    if (req.params.private_token !== db["accounts"][req.params.id]["pending_private_token"]) {
      res.send(400, "Private token mismatch.");
      return;
    }
    if (db["accounts"][req.params.id]["private_token"] === db["accounts"][req.params.id]["pending_private_token"]) {
      res.send(400, "Already verified this account and this private token.");
      return;
    }
    if (!addPendingResponse(req.params.id, res)) {
      return;
    }
    var options = {
      url: 'http://forum15.hkgolden.com/ProfilePage.aspx?userid={}'.format(req.params.id),
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    };
    delayedFunctionRun("hkg_desktop", function() {
      request(options, function(error, response, body) {
        if (error || response.statusCode != 200) {
          sendToAllResponses(req.params.id, 503, "Server has received an invalid response from upstream.");
          return;
        }
        var websiteField = $(body).find("#ctl00_ContentPlaceHolder1_lb_website");
        if (!websiteField.length) {
          sendToAllResponses(req.params.id, 503, "Server has received an invalid response from upstream.");
          return;
        }
        var publicToken = websiteField.text().trim();
        if (publicToken !== db["accounts"][req.params.id]["public_token"]) {
          sendToAllResponses(req.params.id, 417, "Fetched public token does not match database's record.");
          return;
        }
        db["accounts"][req.params.id]["verified"] = true;
        db["accounts"][req.params.id]["private_token"] = db["accounts"][req.params.id]["pending_private_token"];
        sendToAllResponses(req.params.id, 200, "Successfully verified this account or this new private token.");
        saveDb();
      });
    });
  });

  server.use(restify.queryParser());
  server.get('/topic-list/:forum/:page/:id/:private_token', function(req, res, next) {
    res.charSet('utf-8');
    if (checkInt(req.params.id, "ID", res)) {
      return;
    }
    if (checkInt(req.params.page, "Page", res)) {
      return;
    }
    if (VALID_FORUMS.indexOf(req.params.forum) === -1) {
      res.send(400, "Forum is not valid.");
      return;
    }
    if (checkAPIRequest(req, res)) {
      return;
    }

    var isFriend = FRIEND_USER_IDS.indexOf(parseInt(req.params.id)) !== -1;
    var shouldRespondWithCache = !(isFriend && NO_CACHE_FRIEND_REQUESTS) || req.query.cache === "true";

    var cacheKey = "{}-{}".format(req.params.forum, req.params.page - 1);
    var now = Date.now();

    if (shouldRespondWithCache && cacheKey in caches && caches[cacheKey]["expires"] >= now) {
      res.send(caches[cacheKey]["data"]);
      console.log("Cache hit: {}".format(cacheKey));
      return;
    }
    if (!addPendingResponse(cacheKey, res)) {
      return;
    }

    if (!isFriend) {
      if (!checkRateLimit("hkg_access", req.params.private_token, API_ACCESS_RATE_LIMIT_TIMES, true)) {
        res.send(429, "Rate limit exceeded.");
        return true;
      }
    }

    console.log("Requesting: {}".format(cacheKey));
    var options = {
      url: 'http://android-1-1.hkgolden.com/newTopics.aspx?s={}&user_id={}&type={}&page={}&filtermode=N&sensormode=N&returntype=json'.format(
        apiKey(req.params.id), req.params.id, req.params.forum, req.params.page
      ),
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    };
    delayedFunctionRun("hkg_api", function() {
      var startTime = Date.now();
      request(options, function(error, response, body) {
        if (error || response.statusCode != 200) {
          sendToAllResponses(cacheKey, 503, "Server has received an invalid response from upstream.");
          return;
        }
        var finishTime = Date.now();
        pingTime = finishTime - startTime;
        var cache = {
          "data": JSON.parse(body),
          "expires": finishTime + HKGOLDEN_CACHE_TIME
        }
        sendToAllResponses(cacheKey, 200, cache["data"]);
        caches[cacheKey] = cache;
      })
    });
  });

  server.get('/view-topic/:topic_id/:page/:id/:private_token', function(req, res, next) {
    res.charSet('utf-8');
    if (checkInt(req.params.id, "User ID", res)) {
      return;
    }
    if (checkInt(req.params.topic_id, "Topic ID", res)) {
      return;
    }
    if (checkInt(req.params.page, "Page", res)) {
      return;
    }
    if (checkAPIRequest(req, res)) {
      return;
    }
    var page = req.params.page - 1;

    var cacheKey = "{}-{}".format(req.params.topic_id, page);
    if (cacheKey in db["long_cache"]) {
      console.log("Long cache hit: {}".format(cacheKey));
      db["long_cache"][cacheKey]["expires"] = Date.now() + HKGOLDEN_LONG_CACHE_TIME;
      res.send(db["long_cache"][cacheKey]["data"]);
      saveDb();
      return;
    }
    var isFriend = FRIEND_USER_IDS.indexOf(parseInt(req.params.id)) !== -1;
    var shouldRespondWithCache = !(isFriend && NO_CACHE_FRIEND_REQUESTS) || req.query.cache === "true";

    var now = Date.now();
    if (shouldRespondWithCache && cacheKey in caches && caches[cacheKey]["expires"] >= now) {
      console.log("Cache hit: {}".format(cacheKey));
      res.send(caches[cacheKey]["data"]);
      return;
    }
    if (!addPendingResponse(cacheKey, res)) {
      return;
    }

    if (!isFriend) {
      if (!checkRateLimit("hkg_access", req.params.private_token, API_ACCESS_RATE_LIMIT_TIMES, true)) {
        res.send(429, "Rate limit exceeded.");
        return true;
      }
    }

    console.log("Requesting: {}".format(cacheKey));
    var start = page == 0 ? 0 : page * POSTS_PER_PAGE + 1;
    var limit = page == 0 ? POSTS_PER_PAGE + 1 : POSTS_PER_PAGE;

    var options = {
      url: 'http://android-1-1.hkgolden.com/newView.aspx',
      headers: {
        'User-Agent': 'Mozilla/5.0'
      },
      form: {
        s: apiKey(req.params.id),
        user_id: req.params.id,
        message: req.params.topic_id,
        start: start,
        limit: limit,
        filtermode: "N",
        sensormode: "N",
        returntype: "json"
      }
    };

    delayedFunctionRun("hkg_api", function() {
      request(options, function(error, response, body) {
        if (error || response.statusCode != 200) {
          sendToAllResponses(cacheKey, 503, "Server has received an invalid response from upstream.");
          return;
        }
        var cache = {
          "data": JSON.parse(body),
        }
        sendToAllResponses(cacheKey, 200, cache["data"]);
        if (cache["data"]["messages"].length == limit) {
          cache["expires"] = Date.now() + HKGOLDEN_LONG_CACHE_TIME;
          db["long_cache"][cacheKey] = cache;
          saveDb();
        } else {
          cache["expires"] = Date.now() + HKGOLDEN_CACHE_TIME;
          caches[cacheKey] = cache;
        }
      })
    });
  });

  server.use(restify.bodyParser());
  server.post('/raw-request/:id/:private_token', function(req, res, next) {
    res.charSet('utf-8');
    if (checkInt(req.params.id, "User ID", res)) {
      return;
    }
    if (req.body.path.charAt(0) !== '/') {
      res.send(400, "Raw request path is invalid.");
      return;
    }
    if (!("api" in req.body)) {
      res.send(400, "Raw request did not indicate to use API or not.");
      return;
    }
    if (checkAPIRequest(req, res)) {
      return;
    }

    if (FRIEND_USER_IDS.indexOf(parseInt(req.params.id)) === -1) {
      if (!checkRateLimit("hkg_access", req.params.private_token, API_ACCESS_RATE_LIMIT_TIMES, true)) {
        res.send(429, "Rate limit exceeded.");
        return true;
      }
    }

    var options = {
      url: (req.body.api ? "http://android-1-1.hkgolden.com" :
        "http://forum15.hkgolden.com") + req.body.path,
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    };
    if ("rp" in req.body) {
      options.form = req.body.rp.urlParams;
    }
    if ("cookies" in req.body) {
      options.headers["Cookie"] = req.body.cookies;
    }
    var reqLog = {
      "user_id": req.params.id,
      "request_ip": req.headers["x-real-ip"],
      "request": options,
      "timestamp": Date.now()
    }
    log.raw_requests.push(reqLog);
    saveLog();
    delayedFunctionRun(req.body.api ? "hkg_api" : "hkg_desktop", function() {
      request(options, function(error, response, body) {
        if (error || response.statusCode != 200) {
          res.send(503, "Server has received an invalid response from upstream.");
          return;
        }
        //console.log(body);
        res.end(body);
      })
    });

  });

  server.listen(SERVER_PORT, BIND_ADDRESS, function() {
    console.log('%s listening at %s', server.name, server.url);
  });


});
