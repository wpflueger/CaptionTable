import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { registerServiceWorker } from './registerServiceWorker';

createRoot(document.getElementById('root')!).render(<App />);

registerServiceWorker();
