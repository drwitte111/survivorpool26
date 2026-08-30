// The league trash-talk board: posts, reactions and the feed.
import { store } from '../core/state.js';
import { db } from '../core/firebase.js';
import { withTimeout } from '../core/net.js';
import { slugifyTeam } from '../core/league.js';
import { escapeHtml, timeAgo, renderLoadFailure } from './dom.js';

const REACTION_EMOJIS = ['🔥', '💀', '😂'];
// Matches the maxlength on #trashTalkInput in index.html.
const MAX_MESSAGE_LENGTH = 280;

export async function postTrashTalk(message){
  if(!store.state.account.teamName){ return { ok: false, error: 'Go to Account, enter a Team Name, and press Save Profile before posting.' }; }
  if(!store.state.account.leagueSlug){ return { ok: false, error: 'Join a league before posting.' }; }
  const trimmed = message.trim();
  if(!trimmed) return { ok: false, error: 'Message is empty.' };
  const payload = {
    teamName: store.state.account.teamName,
    week: store.currentWeek,
    message: trimmed.slice(0, MAX_MESSAGE_LENGTH),
    postedAt: new Date().toISOString()
  };
  try{
    await db.collection('leagues').doc(store.state.account.leagueSlug).collection('trashtalk').add(payload);
    return { ok: true };
  }catch(e){
    console.error('trash talk post failed', e);
    return { ok: false, error: 'Couldn\u2019t post right now \u2014 try again.' };
  }
}


export async function toggleReaction(postKey, emoji, alreadyReacted){
  const ref = db.collection('leagues').doc(store.state.account.leagueSlug).collection('trashtalk').doc(postKey);
  const fieldPath = 'reactions.' + emoji;
  try{
    if(alreadyReacted){
      await ref.update({ [fieldPath]: firebase.firestore.FieldValue.arrayRemove(store.state.account.teamName) });
    } else {
      await ref.update({ [fieldPath]: firebase.firestore.FieldValue.arrayUnion(store.state.account.teamName) });
    }
    return true;
  }catch(e){
    console.error('toggleReaction failed', e);
    return false;
  }
}


export async function renderTrashTalkFeed(){
  const feedEl = document.getElementById('trashTalkFeed');
  feedEl.innerHTML = '<div class="empty">Loading the feed…</div>';
  try{
    const snap = await withTimeout(
      db.collection('leagues').doc(store.state.account.leagueSlug).collection('trashtalk').get(),
      undefined, 'Loading trash talk');
    const posts = [];
    snap.forEach(docSnap => { posts.push({ key: docSnap.id, ...docSnap.data() }); });
    posts.sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));
    if(!posts.length){
      feedEl.innerHTML = '<div class="empty">No trash talk yet. Be the first to say something.</div>';
      return;
    }
    feedEl.innerHTML = '';
    posts.slice(0, 100).forEach(p => {
      const isMine = store.state.account.teamName && p.teamName === store.state.account.teamName;
      const div = document.createElement('div');
      div.className = 'tt-post';
      div.innerHTML = `
        <div class="tt-post-header">
          <div class="tt-post-meta">
            <span class="tt-post-team">${escapeHtml(p.teamName)}${p.week ? ' \u00b7 Wk ' + p.week : ''}</span>
            <span class="tt-post-time">${timeAgo(p.postedAt)}</span>
          </div>
        </div>
        <div class="tt-post-msg">${escapeHtml(p.message)}</div>`;
      if(isMine){
        const delBtn = document.createElement('button');
        delBtn.className = 'tt-delete-btn';
        delBtn.title = 'Delete this message';
        delBtn.textContent = '\u2715';
        delBtn.onclick = async () => {
          delBtn.disabled = true;
          try{ await db.collection('leagues').doc(store.state.account.leagueSlug).collection('trashtalk').doc(p.key).delete(); }
          catch(e){ console.error('trash talk delete failed', e); }
          renderTrashTalkFeed();
        };
        div.querySelector('.tt-post-header').appendChild(delBtn);
      }

      const reactionRow = document.createElement('div');
      reactionRow.className = 'tt-reaction-row';
      REACTION_EMOJIS.forEach(emoji => {
        const reactedBy = (p.reactions && p.reactions[emoji]) || [];
        const iReacted = store.state.account.teamName && reactedBy.includes(store.state.account.teamName);
        const btn = document.createElement('button');
        btn.className = 'tt-reaction-btn' + (iReacted ? ' active' : '');
        btn.innerHTML = `${emoji}${reactedBy.length ? `<span class="tt-reaction-count">${reactedBy.length}</span>` : ''}`;
        btn.disabled = !store.state.account.teamName;
        btn.title = store.state.account.teamName ? '' : 'Set a Team Name in Account to react';
        btn.onclick = async () => {
          btn.disabled = true;
          await toggleReaction(p.key, emoji, iReacted);
          renderTrashTalkFeed();
        };
        reactionRow.appendChild(btn);
      });
      div.appendChild(reactionRow);

      feedEl.appendChild(div);
    });
  }catch(e){
    console.error('trash talk load failed', e);
    renderLoadFailure(feedEl, {
      message: 'Couldn\u2019t load the feed.',
      onRetry: () => renderTrashTalkFeed(),
    });
  }
}

