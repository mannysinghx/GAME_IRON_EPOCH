// Fonts are bundled and served from this host (no font CDN at runtime, design doc §10.2).
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/chakra-petch/500.css';
import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700.css';
import './ui/styles.css';
import { render } from 'preact';
import { App } from './ui/App.tsx';

render(<App />, document.getElementById('root')!);
