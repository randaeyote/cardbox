import { render } from 'preact'
import { App } from './app.jsx'
import './style.css'
import './update.js'

navigator.storage?.persist?.()

render(<App />, document.getElementById('app'))
