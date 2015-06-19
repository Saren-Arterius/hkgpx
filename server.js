var restify = require('restify');
var env = require('jsdom').env;
var request = require('request');
var fs = require('fs');
var path = require('path');

// Constants
var SAVE_MIN_INTERVAL = 5 * 1000;
var ACCOUNT_CLEANUP_INTERVAL = 600 * 1000;
var dbFilename = path.join(__dirname, "db.json");
var functionMinInterval = {
  "hkg_desktop": 8 * 1000,
  "hkg_api": 3 * 1000,
};
var rateLimitFieldsResetIntervals = {
  "account_action": 10 * 1000
};
var lastSaveDb = 0;

// accounts to be verified
var pendingVerifiedAccounts = [];

// functionNextRun
var functionNextRun = {};
for (var field in functionMinInterval) {
  functionNextRun[field] = 0;
}

var delayedFunctionRun = function(field, func) {
  var now = Date.now();
  if (functionNextRun[field] < now) {
    functionNextRun[field] = now;
  }
  setTimeout(func, functionNextRun[field] - now);
  functionNextRun[field] += functionMinInterval[field];
}

// DB
var saveDb = function() {
  if (Date.now() - lastSaveDb < SAVE_MIN_INTERVAL) {
    return;
  }
  lastSaveDb = Date.now();
  fs.writeFile(dbFilename, JSON.stringify(db), function(err) {
    if (err) {
      return console.log(err);
    }
    console.log("Db was saved!");
  })
};

try {
  var db = JSON.parse(fs.readFileSync(dbFilename));
} catch (e) {
  var db = {
    "rate_limit": {},
    "accounts": {},
  };
} finally {
  saveDb();
}


// Rate limit system
var resetRateLimit = function(field) {
  db["rate_limit"][field] = {};
}

var checkRateLimit = function(field, key, max) {
  if (!(field in db["rate_limit"])) {
    resetRateLimit(field);
  }
  if (!(key in db["rate_limit"][field])) {
    db["rate_limit"][field][key] = 1;
    saveDb();
    return true;
  }
  if (db["rate_limit"][field][key] + 1 > max) {
    return false;
  }
  db["rate_limit"][field][key]++;
  saveDb();
  return true;
}

for (var key in rateLimitFieldsResetIntervals) {
  setInterval(function() {
    resetRateLimit(key);
  }, rateLimitFieldsResetIntervals[key]);
}

// Unverified ac cleanup
setInterval(function() {
  var now = Date.now();
  var modified = false;
  for (var id in db["accounts"]) {
    if (db["accounts"][id]["verified"]) {
      modified = true;
      delete db["accounts"][id]["destroy_if_not_verified_after"];
      continue;
    }
    if (db["accounts"][id]["destroy_if_not_verified_after"] > now) {
      continue;
    }
    modified = true;
    delete db["accounts"][id];
  }
  if (modified) {
    saveDb();
  }
}, ACCOUNT_CLEANUP_INTERVAL);

// Misc functions
var makeID = function() {
  var text = "";
  var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  for (var i = 0; i < 32; i++)
    text += possible.charAt(Math.floor(Math.random() * possible.length));

  return text;
}

var isInt = function(value) {
  return !isNaN(value) &&
    parseInt(Number(value)) == value &&
    !isNaN(parseInt(value, 10));
}

env("", function(errors, window) {
  var $ = require('jquery')(window);
  var server = restify.createServer();

  server.get('/new-account/:id/:private_token', function(req, res, next) {
    if (!isInt(req.params.id)) {
      res.send(400, "ID must be integer.");
      return;
    }
    if (req.params.private_token.length != 32) {
      res.send(400, "Private token's length must be 32.");
      return;
    }
    if (!checkRateLimit("account_action", req.headers["x-real-ip"], 3)) {
      res.send(429, "Rate limit exceeded.");
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
        "destroy_if_not_verified_after": Date.now() + ACCOUNT_CLEANUP_INTERVAL
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

  server.get('/verify-account/:id/:private_token', function(req, res, next) {
    if (!isInt(req.params.id)) {
      res.send(400, "ID must be integer.");
      return;
    }
    if (req.params.private_token.length != 32) {
      res.send(400, "Private token's length must be 32.");
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
    if (pendingVerifiedAccounts.indexOf(req.params.id) !== -1) {
      res.send(409, "System is already verifying user's account.");
      return;
    }
    if (!checkRateLimit("account_action", req.headers["x-real-ip"], 3)) {
      res.send(429, "Rate limit exceeded.");
      return;
    }
    if (db["accounts"][req.params.id]["private_token"] === db["accounts"][req.params.id]["pending_private_token"]) {
      res.send(400, "Already verified this account and this private token.");
      return;
    }
    pendingVerifiedAccounts.push(req.params.id);
    var options = {
      url: 'http://forum15.hkgolden.com/ProfilePage.aspx?userid=' + req.params.id,
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    };
    delayedFunctionRun("hkg_desktop", function() {
      request(options, function(error, response, body) {
        var index = pendingVerifiedAccounts.indexOf(req.params.id);
        pendingVerifiedAccounts.splice(index, 1);
        if (error || response.statusCode != 200) {
          res.send(502, "Server has received an invalid response from upstream.");
          return;
        }
        var websiteField = $(body).find("#ctl00_ContentPlaceHolder1_lb_website");
        if (!websiteField.length) {
          res.send(502, "Server has received an invalid response from upstream.");
          return;
        }
        var publicToken = websiteField.text().trim();
        if (publicToken !== db["accounts"][req.params.id]["public_token"]) {
          res.send(417, "Fetched public token does not match database's record.");
          return;
        }
        db["accounts"][req.params.id]["verified"] = true;
        db["accounts"][req.params.id]["private_token"] = db["accounts"][req.params.id]["pending_private_token"];
        res.send(200, "Successfully verified this account or this new private token.");
        saveDb();
      });
    });
  });


  server.listen(8888, function() {
    console.log('%s listening at %s', server.name, server.url);
  });


});
