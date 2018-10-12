const functions = require('firebase-functions')
// The Firebase Admin SDK to access the Firebase Realtime Database.
const admin = require('firebase-admin')
admin.initializeApp(functions.config().firebase)
var RealtimetrainsClient = require('realtimetrains')
const stations = require('./national-rail-stations/stations')

var db = admin.firestore()

var rttClient = new RealtimetrainsClient({
  'uri': functions.config().rtt.uri,
  'username': functions.config().rtt.username,
  'password': functions.config().rtt.password
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
   console.log("Subscribing to train ", trainUID)
   var subscriptionsDocRef = db.collection('system').doc('subscriptionDocument')
   subscriptionsDocRef.update({
     "subscriptions": admin.firestore.FieldValue.arrayUnion(trainUID)
   }).then((fbRes => {
     console.log("Added subscription to " + trainUID)
     return res.status(200).send('Subscribed to ' + trainUID)

   })).catch((error) => {
     return res.status(500).send("Couldn't subscribe: " + error)
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

  if (journeyTime) {
    locationListQuery.time = journeyTime
  }

  if (journeyDate) {
    locationListQuery.date = journeyDate
  }
  console.log("Querying with ", locationListQuery)
  rttClient.getLocationList(locationListQuery).then((locationList) => {
    console.log("Got schedules response", locationList.data)
    return res.status(200).send(locationList.data)
  }).catch((error) => {
    console.error(error)
    return res.status(500).send("Error querying schedules! ", error)
  })
  return
})

exports.stations = functions.https.onRequest((req, res) => {
  if (req.method !== 'GET') {
    return res.status(403).send('Can\'t' + req.method + ' this function')
  }
  return res.status(200).send(stations)
})

exports.pollSchedules = functions.pubsub.topic('pollSchedules').onPublish((message) => {
  // this message content is irrelevant - a message is generated every minute to trigger this function
  db.collection('system').doc('subscriptionsDocument').then((doc) => {
    if (!doc.exists) {
      console.log("Document doesn't exist!")
    } else {
      console.log("Got list of subscriptions", doc.data())
    }
    return
  }).catch(err => {
      console.log('Error getting document', err)
      return
    });
});
