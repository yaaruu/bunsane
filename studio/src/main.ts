// Type definitions for BunSane metadata
interface ComponentPropertyMetadata {
  component_id: string;
  propertyKey: string;
  type: any;
  options?: any;
}

interface ComponentMetadata {
  name: string;
  target: any;
  options?: any;
}

interface ArcheTypeMetadata {
  name?: string;
  target: any;
  options?: any;
}

interface IndexedFieldMetadata {
  componentId: string;
  propertyKey: string;
  options?: any;
}

interface BunSaneMetadata {
  components: ComponentMetadata[];
  archetypes: ArcheTypeMetadata[];
  indexedFields: Map<string, IndexedFieldMetadata[]>;
  componentProperties: Map<string, ComponentPropertyMetadata[]>;
}

// Extend window interface
declare global {
  interface Window {
    bunsaneMetadata?: BunSaneMetadata;
  }
}

function renderMetadata(metadata: BunSaneMetadata) {
  const content = document.getElementById('content');
  if (!content) return;

  content.innerHTML = `
    <div class="metadata-section">
      <h2>📦 Components (${metadata.components.length})</h2>
      <div class="metadata-json">${JSON.stringify(metadata.components, null, 2)}</div>
    </div>

    <div class="metadata-section">
      <h2>🏗️ Archetypes (${metadata.archetypes.length})</h2>
      <div class="metadata-json">${JSON.stringify(metadata.archetypes, null, 2)}</div>
    </div>

    <div class="metadata-section">
      <h2>🔍 Indexed Fields</h2>
      <div class="metadata-json">${JSON.stringify(Object.fromEntries(metadata.indexedFields), null, 2)}</div>
    </div>

    <div class="metadata-section">
      <h2>⚙️ Component Properties</h2>
      <div class="metadata-json">${JSON.stringify(Object.fromEntries(metadata.componentProperties), null, 2)}</div>
    </div>
  `;
}

function renderError(message: string) {
  const content = document.getElementById('content');
  if (!content) return;

  content.innerHTML = `
    <div class="error">
      <h3>❌ Error Loading Metadata</h3>
      <p>${message}</p>
      <p><strong>Note:</strong> Make sure <code>window.bunsaneMetadata</code> is set by your BunSane application.</p>
    </div>
  `;
}

function init() {
  // Check if metadata is available
  if (typeof window.bunsaneMetadata === 'undefined') {
    renderError('window.bunsaneMetadata is not defined. This studio requires metadata to be injected by the BunSane server.');
    return;
  }

  try {
    renderMetadata(window.bunsaneMetadata);
  } catch (error) {
    renderError(`Failed to render metadata: ${error}`);
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}