import { createApp } from 'vue'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import './styles.css'
import App from './App.vue'
import { UI_THEME_STORAGE_KEY } from './constants/mapApp'

try {
  const storedTheme = localStorage.getItem(UI_THEME_STORAGE_KEY)
  const initialTheme = storedTheme === 'dark' ? 'dark' : 'light'
  document.documentElement.dataset.theme = initialTheme
  const metaThemeColor = document.querySelector('meta[name="theme-color"]')
  if (metaThemeColor) {
    metaThemeColor.setAttribute('content', initialTheme === 'dark' ? '#0f172a' : '#e8f4ff')
  }
} catch {
  document.documentElement.dataset.theme = 'light'
}

createApp(App).mount('#app')
