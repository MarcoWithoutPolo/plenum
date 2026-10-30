import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PickerPreview } from './screens/PickerPreview';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>{location.hash === '#picker-preview' ? <PickerPreview /> : <App />}</StrictMode>,
);
