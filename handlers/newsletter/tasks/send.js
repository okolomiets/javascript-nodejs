var co = require('co');
var fs = require('fs');
var log = require('log')();
var gutil = require('gulp-util');
var glob = require('glob');
const path = require('path');
const Newsletter = require('../models/newsletter');
const Subscription = require('../models/subscription');
const mailer = require('mailer');
const Letter = require('mailer').Letter;
const config = require('config');


module.exports = function(options) {

  return function() {

    return co(function* () {

      var letters = yield Letter.find({
        sent: false,
        // only newsletter emails, not transient ones
        newsletterRelease: {
          $exists: true
        }
      }).exec();

      for (var i = 0; i < letters.length; i++) {
        var letter = letters[i];

        yield mailer.sendLetter(letter);
        gutil.log("Sent to " + letter.message.to[0].email);
      }

    });

  };
};


