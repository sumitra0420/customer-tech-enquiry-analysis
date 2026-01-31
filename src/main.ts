import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { Amplify } from 'aws-amplify';
import { amplifyConfig } from './amplify-config';

// Configures Amplify with your Cognito settings BEFORE anything else runs
Amplify.configure(amplifyConfig);
console.log('Amplify configured successfully');

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
