const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const ObjectId = mongoose.Schema.Types.ObjectId;

const GENERATING_TIME_LIMIT_DEFAULT = 3e3; // 10 sec

const schema = new Schema({
  key: {
    type:     String,
    required: true,
    unique:   true
  },

  tags: [String],

  value: {
    type:     {},
    validate: [
      {
        validator: function(value) {
          return !!(this.generatingStartTimestamp || value !== undefined);
        },
        msg:       "Must have value."
      }
    ]

  },

  generatingStartTimestamp: Date,
  generatingTimeLimit: Number,

  // when to expire?
  // no expireAt means it won't expire
  // mongo autoclears the documents every minute
  expireAt:                   {
    type: Date
  }

});

schema.index({ "expireAt": 1 }, { expireAfterSeconds: 0 });


// get value in a non-waiting way
// skip generating values
schema.statics.get = function* (key) {
  // try to find it
  var result = yield this.findOne({key: key}).exec();

  // no value - fine..
  if (!result) return result;

  // if it's actually a generating value, consider that as no-value (yet)
  if (result.generatingStartTimestamp) return null;

  return result.value;
};

// generate the value using *generator
// or get it from db (if someone else has generated it)
//   --> never runs generators in parallel
//   --> never returns stale values
schema.statics.getOrGenerate = function* (doc, generator) {
  var CacheEntry = this;
  // try to find it
  var result;

  // disable cache for development
  if (process.env.NODE_ENV != 'development') {
    result = yield CacheEntry.findOne({key: doc.key}).exec();
  }

  var generatingStartTimestamp;

  // no value - fine..
  if (!result) {
    generatingStartTimestamp = Date.now();
    try {
      yield new CacheEntry({ key: doc.key, generatingStartTimestamp: generatingStartTimestamp }).persist();
    } catch (e) {
      // lost the race, someone has already persisted it and started generating
      if (e.name == 'MongoError' && e.code == 11000) {
        // let's try again
        return yield CacheEntry.getOrGenerate(doc, generator);
      } else {
        throw e;
      }
    }

    var value = yield generator();

    // the case
    //  -> we started to generate
    //  -> set or remove is called for the key
    //  -> we finished generating
    // we consider set/remove here to be more important because this decision is taken LATER then generation
    // maybe something important has changed
    // so we restart generation
    var old = yield this.findOneAndUpdate(
      // replace the very exact record we've made
      // it's possible that someone called set(doc, value) and replaced it while we were generating
      { key: doc.key, generatingStartTimestamp: generatingStartTimestamp },
      // $set every field of the document (to fully replace, not update)
      // setting to undefined doesn't work here (mongoose bug?)
      {
        key: doc.key,
        tags: doc.tags || [],
        value: value,
        expireAt: doc.expireAt || null,
        generatingStartTimestamp: null,
        generatingTimeLimit: null
      },
      // don't generate a new document, return the old one
      { new: false, upsert: false }
    ).exec();

    if (!old) {
      // while we were generating, someone called set on the value (ouch!) or removed it (ouch ouch!)
      // that's because something has changed.
      // let's regenerate the value
      return yield CacheEntry.getOrGenerate(doc, generator);
    }

    return value;
  }

  // otherwise check if it's actually a generating value
  generatingStartTimestamp = result.generatingStartTimestamp;

  // not generating - fine..
  if (!generatingStartTimestamp) return result.value;

  // now check if we're waiting for too long
  var timeLimit = result.generatingTimeLimit || GENERATING_TIME_LIMIT_DEFAULT;

  if (Date.now() > generatingStartTimestamp + timeLimit) {
    // too long wait, consider the value absent
    // delete this very record: not just any of this key, but actually the outdated one
    // (maybe someone else has done that already)
    yield CacheEntry.destroy({key: doc.key, generatingStartTimestamp: result.generatingStartTimestamp});
    // ...and try again
    return yield CacheEntry.getOrGenerate(doc, generator);
  }

  // waiting for not very long, someone is working on it,
  // let's pause a little bit
  yield function(callback) {
    setTimeout(callback, 100);
  };

  // ...and retry
  return yield CacheEntry.getOrGenerate(doc, generator);
};


// cache set, replaces and returns the old value if exists
schema.statics.set = function* (doc) {
  return yield this.findOneAndUpdate(
    { key: doc.key },
    {
      key: doc.key,
      tags: doc.tags || [],
      value: doc.value,
      expireAt: doc.expireAt || null,
      generatingStartTimestamp: null,
      generatingTimeLimit: null
    },
    {new: false, upsert: true}
  ).exec();
};


module.exports = mongoose.model('CacheEntry', schema);
