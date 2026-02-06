import { ResourcesConfig } from 'aws-amplify';
import { environments } from './environments/environments'; 

// Stores your AWS Cognito credentials
export const amplifyConfig: ResourcesConfig = {
  Auth: {
    Cognito: {
      userPoolId: environments.cognito.userPoolId,
      userPoolClientId: environments.cognito.userPoolClientId,
    },
  },
};
