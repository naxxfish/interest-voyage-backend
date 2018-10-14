# Interest Voyage

I'll describe what this is in more detail when it's more ready ;)

## Prerequisites

You'll need to have the Google Cloud SDK and Firebase CLI installed, and have a project set up to deploy to

## Deploying

    firebase deploy

And to make the AppEngine cron component deploy:

    cd appengine
    gcloud app deploy app.yaml cron.yaml
