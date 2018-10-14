const functions = require('firebase-functions')
// The Firebase Admin SDK to access the Firebase Realtime Database.
const admin = require('firebase-admin')
const PubSub = require(`@google-cloud/pubsub`)
const moment = require('moment')

const pubsubClient = new PubSub({
  projectId: process.env.GOOGLE_CLOUD_PROJECT
})

admin.initializeApp(functions.config().firebase)
var RealtimetrainsClient = require('realtimetrains')
const stations = require('./national-rail-stations/stations')

var db = admin.firestore()
db.settings({timestampsInSnapshots: true})

var rttClient = new RealtimetrainsClient({
  'uri': functions.config().rtt.uri,
  'username': functions.config().rtt.username,
  'password': functions.config().rtt.password
})

function getISODate(date) {
  return [date.getFullYear(),
          date.getMonth()+1,
          date.getDate()].join('/')
}

function getServiceSelector(trainUID, trainDate) {
  return trainUID + '_' + moment(trainDate,'YYYY/MM/DD').format('YYYY-DD-MM')
}

function getDateFromTrainDate(trainDate) {
  return moment(trainDate,'YYYY/MM/DD').toDate()
}

function getFBTimestampFromTrainDate(trainDate) {
  return admin.firestore.Timestamp.fromDate(getDateFromTrainDate(trainDate))
}

function requestScheduleUpdate(trainScheduleQuery) {
  return pubsubClient.topic('scheduleUpdate')
    .publisher()
    .publish(Buffer.from(JSON.stringify(trainScheduleQuery)))
}

function validateTrainDate(trainDate, mandatory = false) {
  return new Promise((resolve, reject) => {
    if ((trainDate === undefined || trainDate === '') && mandatory) {
      reject(new Error('date not specified'))
    }
    // if it's not been specified but it's optional, resolve
    if ((trainDate === undefined || trainDate === '') && ! mandatory) {
      resolve()
    }
    if (! trainDate.match(/^\d{4}\/\d{2}\/\d{2}$/)) {
      reject(new Error('invalid date format'))
    } else {
      resolve()
    }
  })
}

function validateTrainTime(trainTime, mandatory = false) {
    var timeRegex = /^\d{4}$/
    return new Promise((resolve, reject) => {
      // if it's not been specified, and it's mandatory, reject
      if ((trainTime === undefined || trainTime === '') && mandatory) {
        reject(new Error('train time not specified'))
      }
      // if it's not been specified but it's optional, resolve
      if ((trainTime === undefined || trainTime === '') && ! mandatory) {
        resolve()
      }
      if (! trainTime.match(/^\d{4}$/)) {
        reject(new Error('invalid time format'))
      } else {
        resolve()
      }
    })
}

function validateTrainUID(trainUID) {
  return new Promise((resolve, reject) => {
    if (trainUID === undefined || trainUID === '') {
      return reject(new Error('train uid not specified'))
    }
    if (! trainUID.match(/^[A-Z]\d{5}$/)) {
      return reject(new Error('invalid train uid'))
    } else {
      return resolve()
    }
  })
}

function validateCRS(crs) {
  return new Promise((resolve, reject) => {
    if (crs === undefined || crs === '')
    {
      reject(new Error('crs not specified'))
    }
    if (! crs.match(/^[A-Z]{3}$/)) {
      return reject(new Error('invalid crs'))
    } else {
      return resolve()
    }
  })
}

function concatenateDescriptions(stationList) {
  var stationTexts = []
  stationList.forEach((origin) => {
    stationTexts.push(origin.description)
  })
  return stationTexts.join(' / ')
}

exports.stations = functions.https.onRequest((req, res) => {
  if (req.method !== 'GET') {
    return res.status(403).send('Can\'t' + req.method + ' this function')
  }
  return res.status(200).send(stations)
})

exports.subscribe = functions.https.onRequest((req, res) => {
   if (req.method !== 'PUT') {
     return res.status(403).send('Cannot ' + req.method + ' this function')
   }
   var trainUID = req.query['trainUID']
   var trainDate = req.query['trainDate']
   return Promise.all([
     validateTrainUID(trainUID),
     validateTrainDate(trainDate,true)
   ]).catch((error) => {
        return res.status(500).send(error)
   }).then(() => {
     var trainFBDate = getFBTimestampFromTrainDate(trainDate)
     console.log("Subscribing to train ", trainUID)
     const SERVICE_SELECTOR = getServiceSelector(trainUID,trainDate)
     return db.collection('subscriptions').doc(SERVICE_SELECTOR).set(
       {
         trainUID,
         trainDate,
         trainFBDate,
         errorCount: 0
       }
     )
   }).then(fbRes => {
     console.log("Added subscription to " + trainUID)
     return res.status(200).send('Subscribed to ' + trainUID)
   }).then(() => {
     return requestScheduleUpdate({'trainUID': trainUID, 'trainDate': trainDate })
   }).catch((error) => {
     return res.status(500).send("Couldn't subscribe: " + error)
   })
})

exports.journeyPlaylist = functions.https.onRequest((req, res) => {
  // we expect a service UID and a date
  var trainUID = req.query['trainUID']
  var trainDate = req.query['trainDate']
  Promise.all([
    validateTrainUID(trainUID),
    validateTrainDate(trainDate,true)
  ]).then(() => {
    return rttClient.getService({
      'service': trainUID,
      'date': trainDate
    })
  }).then((service) => {
    // loop through the calling points and see if what assets we have to each tiploc
    if (service.data.error) {
      console.error('rtt api error', service.data.error)
      throw new Error("rtt api error: " + service.data.error)
    }
    if (!(service.data && service.data.locations))
    {
      console.error('no locations...',service.data)
      throw new Error("train has no locations")
    }
    var assetPromises = []
    service.data.locations.map((location) => {
      return assetPromises.push( db.collection('assets').where('tiploc','==',location.tiploc).get() )
    })
    return assetPromises
  })
  .then( (assetPromises) => { return Promise.all(assetPromises) } )
  .then((snapshots) => {
    var list = []
    snapshots.forEach((snapshot) => {
      snapshot.forEach((doc) => {
        if (!doc.exists)
        {
          return
        } else {
          list.push(doc.data())
        }
      })
    })
    return res.status(200).send(list)
  })
  .catch((error) => {
    return res.status(500).send({'error': error.message})
  })
})

exports.schedules = functions.https.onRequest((req, res) => {
  if (req.method !== 'GET') {
    return res.status(403).send('Can\'t' + req.method + ' this function')
  }
  var startStation = req.query['start']
  var endStation = req.query['end']
  var journeyDate = req.query['date']
  var journeyTime = req.query['time']

  return Promise.all([
    validateCRS(startStation),
    validateCRS(endStation),
    validateTrainDate(journeyDate),
    validateTrainTime(journeyTime)]).then(() => {
      var locationListQuery = {
        station: startStation,
        toStation: endStation,
      }
      if (!(journeyTime === undefined || journeyTime === '')) {
        // if a time is specified, then include it in the query
        locationListQuery.time = journeyTime
      }
      if (journeyDate === undefined || journeyDate === '') {
        // if date is not specified, assume today
        locationListQuery.date = getISODate(new Date())
      } else {
        locationListQuery.date = journeyDate
      }
      return locationListQuery
    }).then((locationListQuery) => {
      return rttClient.getLocationList(locationListQuery)
    }).then((locationList) => {
        if (!locationList.data.services)
        {
          console.error('No services in rtt API response ', locationList.data)
          throw new Error('No services running from that station')
        }
        var services = locationList.data.services
        var servicesList = []
        services.forEach((service) => {
          if (service.isPassenger)
          {
            servicesList.push({
              'origin': concatenateDescriptions(service.locationDetail.origin),
              'destination': concatenateDescriptions(service.locationDetail.destination),
              'timetableTime': service.locationDetail.gbttBookedDeparture,
              'timetableDate': service.runDate,
              'trainUID': service.serviceUid,
              'toc': service.atocName,
              'tocCode': service.atocCode
            })
          }
        })
        return servicesList
    }).then((servicesList) => {
      res.status(200).send(servicesList)
    })
    .catch((error) => {
        console.error(error)
        return res.status(500).send({'error': error.message})
      })
})

exports.triggerScheduleUpdates = functions.pubsub.topic('pollSchedules').onPublish((message) => {
  // this message content is irrelevant - a message is generated every minute to trigger this function
  return db.collection('subscriptions').get().then((snapshot) => {
    var pubSubResponses = []
    snapshot.forEach((subscriptionRef) => {
      var subscription = subscriptionRef.data()
      console.log('trainUID', subscription.trainUID)
      pubSubResponses.push( requestScheduleUpdate({'trainUID': subscription.trainUID, 'trainDate': subscription.trainDate }) )
    })
    return pubSubResponses
  }).then((messagePromises) => {
    return Promise.all(messagePromises)
  })
  .then(messageIds => {
      return console.log(`Queued ${messageIds.length} schedules to update`)
  })
  .catch(err => {
      console.log('Error getting Subscriptions document', err)
      return null
  })
})

exports.scheduleUpdate = functions.pubsub.topic('scheduleUpdate').onPublish((message) => {
  let trainUID = null, trainDate = null;
  try {
    trainUID = message.json.trainUID
    trainDate = message.json.trainDate
  } catch (e) {
    throw new Error(`schedule update trigger message couldn't be parsed ${e}`)
  }
  const SERVICE_SELECTOR = getServiceSelector(trainUID,trainDate)
  console.log(`Updating schedule for trainUID: ${trainUID}, trainDate: ${trainDate} doc.id ${SERVICE_SELECTOR}`)
  return rttClient.getService({
    'service':trainUID,
    'date':trainDate
  })
  .then(serviceResp => {
    var service = serviceResp.data
    //console.log('rtt response',service)
    if (service.error)
    {
      // schedule request returned an error
      // TODO: we should count how many times the errors have occurred and do something about that (perhaps remove the subscription)
      throw new Error(`rtt.api error ${trainUID} for ${trainDate}: ${service.error}`)
    }
    // add runDate as Firestore timestamp so we can clean it up later
    service.runDateTS = admin.firestore.Timestamp.fromDate(moment(service.runDate, 'YYYY-MM-DD').toDate())
    return service
  })
  .then((service) => {
    return db.collection('schedules').doc(SERVICE_SELECTOR).set(service)
  })
  .then(() => {
    return console.log(`Updated ${trainUID} for ${trainDate}`)
  }).catch(err => {
    // count an error updating the schedule in the subscription
    var subscriptionRef = db.collection('subscriptions').doc(SERVICE_SELECTOR)
    var incrementErrorTransaction = db.runTransaction(t => {
      return t.get(subscriptionRef).then(doc => {
        var newErrorCount = doc.data().errorCount + 1
        return t.update(subscriptionRef, { errorCount: newErrorCount })
      })
    })
    return console.error(err)
  })
})

exports.hourlyCleanup = functions.pubsub.topic('hourlyCleanup').onPublish((message) => {
  // TODO: loop through subscriptions and delete ones with a high number of errors
  const MAX_ERROR_COUNT = 20
  return db.collection('subscriptions').where('errorCount', '>', MAX_ERROR_COUNT)
    .get()
    .then((snapshot) => {
      if (snapshot.size === 0) {
        console.log("No subscriptions to remove")
        return 0;
      }
      var batch = db.batch()
      snapshot.docs.forEach((doc) => {
        console.log(`Deleting subscription ${doc.id} with ${doc.data().errorCount} errors`)
        return batch.delete(doc.ref)
      })
      return batch.commit()
    }).then((numDeleted) => {
      return console.log(`Removed ${numDeleted} subscriptions with >${MAX_ERROR_COUNT} errors`)
    }).catch((error) => {
      return console.error(`Error performing hourly cleanup: ${error.message}`)
    })
})

exports.dailyCleanup = functions.pubsub.topic('dailyCleanup').onPublish((message) => {
  // cleanup subscriptions
  var cleanupBeforeThisDate = admin.firestore.Timestamp.fromDate(moment().subtract(1,'days').toDate())
  var subscriptionCleanupPromise = db.collection('subscriptions')
    .where('trainFBDate','<',cleanupBeforeThisDate)
    .get()
    .then((snapshot) => {
      if (snapshot.size === 0) {
        console.log("No subscriptions to delete")
        return 0;
      }
      var batch = db.batch()
      snapshot.docs.forEach((doc) => {
        console.log("Deleted subscription " + doc.id)
        return batch.delete(doc.ref)
      })
      return batch.commit()
    }).catch(error => {
      console.error(error)
      return error
    })
  var scheduleCleanupPromise = db.collection('schedules')
    .where('runDateTS', '<', cleanupBeforeThisDate)
    .get()
    .then((snapshot) => {
      if (snapshot.size === 0) {
        console.log("No schedules to delete")
        return 0;
      }
      var batch = db.batch()
      snapshot.forEach(doc => {
        console.log("Deleted schedule " + doc.id)
        return batch.delete(doc.ref)
      })
      return batch.commit()
    }).catch(error => {
      console.error(error)
      return error
    })
    return Promise.all([subscriptionCleanupPromise, scheduleCleanupPromise]).then(() => {
      return console.log("Completed schedule and subscription cleanup")
    })
})
