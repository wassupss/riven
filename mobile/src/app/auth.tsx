import { Redirect } from 'expo-router'

// Where the sign-in browser returns to (rivenremote://auth). The code in it is
// taken by signIn() through the auth session; if the system opened this link
// as a route instead, there is nothing to show here but the home screen.
export default function AuthReturn(): JSX.Element {
  return <Redirect href="/" />
}
