// The Rules page. Copy lives in data/rules.json so the rules can be reworded
// without touching any code.
import { RULES } from '../core/data.js';

export function renderRulesContent(){
  const el = document.getElementById('rulesContent');
  el.innerHTML = RULES
    .map(section => `<h3>${section.heading}</h3>\n${section.body.join('\n')}`)
    .join('\n');
}
