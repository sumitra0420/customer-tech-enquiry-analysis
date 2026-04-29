import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { Amplify } from 'aws-amplify';
import { amplifyConfig } from './amplify-config';
import { AwsRum, AwsRumConfig } from 'aws-rum-web';

// Configures Amplify with your Cognito settings BEFORE anything else runs
Amplify.configure(amplifyConfig);
console.log('Amplify configured successfully');

try {
  const config: AwsRumConfig = {
    sessionSampleRate: 1,
    identityPoolId: 'ap-southeast-2:e156bf9b-78e5-47d6-abc2-70f8606756d6',
    endpoint: 'https://dataplane.rum.ap-southeast-2.amazonaws.com',
    telemetries: ['performance', 'errors', 'http'],
    allowCookies: true,
    enableXRay: false,
    signing: true,
  };
  const APPLICATION_ID = '0adf235c-84c8-4a78-b027-ffaf516ed03f';
  const APPLICATION_VERSION = '1.0.0';
  const APPLICATION_REGION = 'ap-southeast-2';
  new AwsRum(APPLICATION_ID, APPLICATION_VERSION, APPLICATION_REGION, config);
} catch (error) {
  // Ignore errors thrown during CloudWatch RUM web client initialization
}

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
