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
   if (trainUID === undefined || trainUID === '') {
     return res.status(500).send('no train ID specified')
   }
   if (! trainUID.match(/^[A-Z]\d{5}$/)) {
     return res.status(500).send('Invalid train ID')
   }
   var trainDate = req.query['trainDate']
   if (trainDate === undefined || trainDate === '') {
     return res.status(500).send('no train ID specified')
   }
   if (! trainDate.match(/^\d{4}\/\d{2}\/\d{2}$/)) {
     return res.status(500).send('Invalid train date')
   }
   // turn the date into a moment object
   var trainDateMomentObject = moment(trainDate, 'YYYY/MM/DD')
   var trainFBDate = admin.firestore.Timestamp.fromDate(trainDateMomentObject.toDate())
   console.log("Subscribing to train ", trainUID)
   return db.collection('subscriptions').doc(trainUID + '_' + trainDateMomentObject.format('YYYY-DD-MM')).set(
     {
       trainUID,
       trainDate,
       trainFBDate
     }
   ).then(fbRes => {
     console.log("Added subscription to " + trainUID)
     return res.status(200).send('Subscribed to ' + trainUID)
   }).catch((error) => {
     return res.status(500).send("Couldn't subscribe: " + error)
   })
})

exports.journeyPlaylist = functions.https.onRequest((req, res) => {
  // we expect a service UID and a date
  var trainUID = req.query['trainUID']
  if (trainUID === undefined || trainUID === '') {
    return res.status(500).send('no train ID specified')
  }
  if (! trainUID.match(/^[A-Z]\d{5}$/)) {
    return res.status(500).send('Invalid train ID')
  }

  var trainDate = req.query['trainDate']
  if (trainDate === undefined || trainDate === '') {
    return res.status(500).send('no date specified')
  }
  if (! trainDate.match(/^\d{4}\/\d{2}\/\d{2}$/)) {
    return res.status(500).send('Invalid train date')
  }
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
      assetPromises.push( db.collection('assets').where('tiploc','==',location.tiploc).get() )
      return
    })
    return Promise.all(assetPromises).then((snapshots) => {
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
  }).catch((error) => {
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
    locationListQuery.date = getISODate(new Date())
  }

  console.log("Querying with ", locationListQuery)
  rttClient.getLocationList(locationListQuery).then((locationList) => {
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
    return snapshot.forEach((subscriptionRef) => {
      var subscription = subscriptionRef.data()
      console.log('trainUID', subscription.trainUID)
      pubsubClient
      .topic('scheduleUpdate')
      .publisher()
      .publish(Buffer.from(JSON.stringify({'trainUID': subscription.trainUID, 'trainDate': subscription.trainDate })))
      .then(messageId => {
        console.log(`Queued ${subscription.trainUID} to be polled (${messageId} published)`)
        return null
      })
      .catch(err => {
        console.error('ERROR:', err)
        return null
      })
    })
  }).catch(err => {
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
    console.error('PubSub message was not JSON', e);
  }
  const SERVICE_SELECTOR = trainUID
  console.log('trainUID:', trainUID, 'trainDate', trainDate)
  return db.collection('schedules').doc(SERVICE_SELECTOR).get().then((doc) => {
    return rttClient.getService({
      'service':trainUID,
      'date':trainDate
    }).then(serviceResp => {
      var service = serviceResp.data
      // add runDate as Firestore timestamp
      service.runDateTS = admin.firestore.Timestamp.fromDate(moment(service.runDate, 'YYYY-MM-DD').toDate())
      return db.collection('schedules').doc(SERVICE_SELECTOR).set(service)
    })
  }).catch(err => {
      console.log('Error getting Schedule document', err)
      return
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
