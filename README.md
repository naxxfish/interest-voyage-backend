# Interest Voyage

![Overview header](https://naxxfish.github.io/interest-voyage-backend/header.png)

So, you're going on a train journey to somewhere new - or even somewhere familiar. It's pretty boring, and there's only so much Spotify you can listen to. And, surely, there's something interesting outside of your train window, if only you knew about it ...

Interest Voyage is an app which let you explore the places you pass through on a long train journey, by serving snippets of interesting audio along the way.

## What's this thing, then?

This bit of the app is the backend - which does most of the hard work looking after the audio assets, looking up train timetables and live running information to make sure the audio is given to you at the right time.

It's mostly made out of [Firebase Cloud Functions](https://firebase.google.com/docs/functions/), with a spot of AppEngine because *grumble grumble* there's no way to [run functions periodically](https://github.com/FirebaseExtended/functions-cron).

## Prerequisites

You'll need to have the Google Cloud SDK and Firebase CLI installed, and have a project set up to deploy to, using ```firebase login```

## Configuration

You'll need to set some configuration variables so that we can talk to the [realtimetrains api](https://api.rtt.io)

    firebase functions:config:set rtt.uri="https://api.for.realtimetrains/v1" rtt.username="YOUR_RTT_API_USERNAME" rtt.password="YOUR_RTT_API_PASSWORD"

And, if you want to run the functions locally, do this after setting those variables:

    firebase functions:config:get > functions/.runtimeconfig.json

Then, you can serve the functions like this:

    firebase serve --only functions

And/or if you need to access the PubSub functions as well

    firebase functions:shell

From which shell you can then invoke something like this:

    hourlyCleanup({data: new Buffer('}')})


## Deploying

Providing you've got your project set up correctly, should be as simple as:

    firebase deploy

And to make the AppEngine cron component deploy:

    cd appengine
    gcloud app deploy app.yaml cron.yaml

## TODO

 * Should really set up some [unit tests](https://firebase.google.com/docs/functions/unit-testing)
 * Reformat the schedule documents so that they only contain useful information
 * ... plus, like, a million other things
