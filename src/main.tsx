import { render } from 'preact';
import { App } from './ui/App';
import { AppController } from './ui/controller';
import './ui/styles.css';

const app = new AppController();
render(<App app={app} />, document.getElementById('root')!);

// Expose for debugging and end-to-end tests.
(window as unknown as { __app: AppController }).__app = app;

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service worker failed', e));
  });
}
