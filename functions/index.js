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
  return moment(trainDate,'YYYY/MM/DD').format('YYYY-DD-MM').toDate()
}

function getFBTimestampFromTrainDate(dateObj) {
  return admin.firestore.Timestamp.fromDate(getDateFromTrainDate(dateObj))
}

function validateTrainDate(trainDate) {
  return new Promise((resolve, reject) => {
    if (trainDate === undefined || trainDate === '') {
      reject(new Error('no train ID specified'))
    }
    if (! trainDate.match(/^\d{4}\/\d{2}\/\d{2}$/)) {
      reject(new Error('Invalid train date'))
    }
    resolve()
  })
}

function validateTrainUID(trainUID) {
  return new Promise((resolve, reject) => {
    if (trainUID === undefined || trainUID === '') {
      reject(new Error('no train ID specified'))
    }
    if (! trainUID.match(/^[A-Z]\d{5}$/)) {
      reject(new Error('Invalid train ID'))
    }
    resolve()
  })
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
     validateTrainDate(trainDate)
   ]).catch((error) => {
        return res.status(500).send(error)
   }).then(() => {
     var trainFBDate = getFBTimestampFromTrainDate(trainDate)
     console.log("Subscribing to train ", trainUID)
     const SERVICE_SELECTOR = getServiceSelector(trainUID,trainDate)
     return db.collection('subscriptions').doc().set(
       {
         trainUID,
         trainDate,
         trainFBDate
       }
     )
   }).then(fbRes => {
     console.log("Added subscription to " + trainUID)
     return res.status(200).send('Subscribed to ' + trainUID)
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
    validateTrainDate(trainDate)
    ]).catch((error) => {
       return res.status(500).send(error)
   })
  return rttClient.getService({
    'service': trainUID,
    'date': trainDate
  }).then((service) => {
    // loop through the calling points and see if what assets we have to each tiploc
    if (!(service.data && service.data.locations))
    {
      return res.status(500).send("No locations")
    }
    var assetPromises = []
    service.data.locations.map((location) => {
      return assetPromises.push( db.collection('assets').where('tiploc','==',location.tiploc).get() )
    })
    return assetPromises
  })
  .then( Promise.all(assetPromises) )
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
    return res.status(500).send('Could not retrieve service: ' + error)
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
  var locationListQuery = {
    station: startStation,
    toStation: endStation,
  }
  var crsRegex = /^[A-Z]{3}$/
  var dateRegex = /^\d{4}-\d{2}-\d{2}$/
  var timeRegex = /^\d{4}$/
  if ( (! startStation.match(crsRegex)) || (! endStation.match(crsRegex)) ) {
    return res.status(500).send('Invalid request')
  }

  if (journeyTime) {
    if (journeyTime.match(timeRegex))
    {
      locationListQuery.time = journeyTime
    } else {
      return res.status(500).send('invalid time format')
    }
  }

  if (journeyDate) {
    if (journeyDate.match(dateRegex))
    {
      locationListQuery.date = journeyDate
    } else {
      return res.status(500).send('invalid date format')
    }
  } else {
    // if all else fails, assume we're talking about today
    locationListQuery.date = getISODate(new Date())
  }

  console.log("Querying with ", locationListQuery)
  return rttClient.getLocationList(locationListQuery).then((locationList) => {
    if (!locationList.data.services)
    {
      console.error("Didn't see the list of servicers in RealTimeTrain API response", locationList.data)
      return res.status(500).send("Incomplete response")
    }
    console.log("Got schedules response", locationList.data)
    var services = locationList.data.services
    var servicesList = []
    services.forEach((service) => {
      var origins = service.locationDetail.origin
      var originTexts = []
      origins.forEach((origin) => {
        originTexts.push(origin.description)
      })
      var originText = originTexts.join(' / ')

      var destinations = service.locationDetail.destination
      var destinationTexts = []
      destinations.forEach((destination) => {
        destinationTexts.push(destination.description)
      })
      var destinationText = destinationTexts.join(' / ')

      var serviceLine = {
        'origin': originText,
        'timetableTime': service.locationDetail.gbttBookedDeparture,
        'timetableDate': service.runDate,
        'destination': destinationText,
        'trainUID': service.serviceUid,
        'toc': service.atocName,
        'tocCode': service.atocCode
      }
      if (service.isPassenger)
      {
        servicesList.push(serviceLine)
      }
    })
    console.log(servicesList)
    return res.status(200).send(servicesList)
  }).catch((error) => {
    console.error(error)
    return res.status(500).send("Error querying schedules! ", error)
  })
})

exports.triggerScheduleUpdates = functions.pubsub.topic('pollSchedules').onPublish((message) => {
  // this message content is irrelevant - a message is generated every minute to trigger this function
  return db.collection('subscriptions').get().then((snapshot) => {
    var pubSubResponses = []
    snapshot.forEach((subscriptionRef) => {
      var subscription = subscriptionRef.data()
      console.log('trainUID', subscription.trainUID)
      pubSubResponses.push( pubsubClient.topic('scheduleUpdate')
        .publisher()
        .publish(Buffer.from(JSON.stringify({'trainUID': subscription.trainUID, 'trainDate': subscription.trainDate })))
      )
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
    console.log('rtt response',service)
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
    return console.error(err)
  })
})

exports.cleanup = functions.pubsub.topic('cleanup').onPublish((message) => {
  // cleanup subscriptions
  var cleanupBeforeThisDate = admin.firestore.Timestamp.fromDate(moment().subtract(2,'days').toDate())
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
