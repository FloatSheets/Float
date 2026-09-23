import page_index from './index.json';
import page_404 from './404.json';
import page_protocol_index from './protocol-index.json';
import page_dashboard_index from './dashboard-index.json';
import page_research_listings_index from './research-listings-index.json';
import page_research_oracle_index from './research-oracle-index.json';
import page_research_risk_index from './research-risk-index.json';
import page_research_vault_index from './research-vault-index.json';
import page_legal_privacy_index from './legal-privacy-index.json';
import page_legal_terms_index from './legal-terms-index.json';
import page_legal_risk_index from './legal-risk-index.json';
// Keep the generated page manifest intact while adding the live market adapter
// to the dashboard at runtime.
const dashboard = { ...page_dashboard_index, scripts: [...page_dashboard_index.scripts, '/dashboard/live.js', '/dashboard/live-ui.js'] };
export const pages = [page_index,page_404,page_protocol_index,dashboard,page_research_listings_index,page_research_oracle_index,page_research_risk_index,page_research_vault_index,page_legal_privacy_index,page_legal_terms_index,page_legal_risk_index];
