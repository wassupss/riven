import React from 'react'
import ReactDOM from 'react-dom/client'
import PetDevice from './components/PetDevice'
import { AssistantCard } from './components/PetChatDialog'
import { loadSettings, getSettings } from './state/settings'
import { applyTheme } from './state/themes'
import { installNoNativeMenu } from './lib/noNativeMenu'
import './styles.css'

// ---------------------------------------------------------------------------
// The entry for 리븐펫's own desktop window. Deliberately minimal: it boots
// the theme + language and mounts the same device the app embeds — no dock, no
// editor, no terminals. The pet's save (pet.json) is shared with the app,
// and only one of the two is ever mounted, so there is no second feeder.
// ---------------------------------------------------------------------------

// The window itself is transparent (main sets transparent: true), but the app's
// stylesheet paints a canvas on <body>. This marks the document so the shell can
// float on nothing — without it the pet arrives in an opaque grey box.
document.documentElement.classList.add('pet-window')
// No WebKit right-click menu on the pet window either.
installNoNativeMenu()

void loadSettings().then(() => applyTheme(getSettings().theme))

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PetDevice detached />
    <AssistantCard anchor="detached" />
  </React.StrictMode>
)
