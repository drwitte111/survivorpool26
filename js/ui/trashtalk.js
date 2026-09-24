// The league trash-talk board: posts, reactions, the feed, and the unread
// badge that points people at it.
import { store } from '../core/state.js';
import { db } from '../core/firebase.js';
import { withTimeout } from '../core/net.js';
import { slugifyTeam } from '../core/league.js';
import { saveState } from '../core/persist.js';
import { isAdmin } from '../core/roles.js';
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
    // The person behind the team name, so a post reads as "theOX -- Caleb"
    // rather than leaving everyone to guess who's actually talking.
    yourName: store.state.account.yourName || '',
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
      div.className = 'tt-post' + (p.commissioner ? ' tt-commissioner' : '');
      div.innerHTML = `
        <div class="tt-post-header">
          <div class="tt-post-meta">
            <span class="tt-post-team">${p.commissioner ? '\ud83c\udfc8 ' : ''}${escapeHtml(p.teamName)}${p.yourName ? ' \u2014 ' + escapeHtml(p.yourName) : ''}${p.week ? ' \u00b7 Wk ' + p.week : ''}</span>
            <span class="tt-post-time">${timeAgo(p.postedAt)}</span>
          </div>
        </div>
        <div class="tt-post-msg">${escapeHtml(p.message)}</div>`;
      // Anyone deletes their own post; an admin can also clean up a bad
      // Commissioner recap, since nobody's own account "owns" that one.
      if(isMine || (p.commissioner && isAdmin())){
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


// ---------------------------------------------------------------------------
// Unread notifications: a count on the Menu button and again on the Trash
// Talk item inside it, so there's a nudge to go look whether or not the menu
// is open -- plus a banner across the top of the page for a Commissioner
// recap specifically, since that's the one post everyone should actually
// read and a small corner badge kept going unnoticed for it. The banner is a
// one-time nudge per post (dismissing it, or reading the feed, both retire
// it for that post); the badges stay lit -- a real unread count -- until the
// feed is actually opened.
// ---------------------------------------------------------------------------

/**
 * Unread posts (not your own) since the feed was last opened, plus the
 * newest unread Commissioner recap if there is one -- that post gets called
 * out by name rather than folded into a generic number, since "someone said
 * something" and "the weekly recap is up" are different-urgency news.
 */
export async function getUnreadTrashTalkInfo(){
  if(!store.state.account.leagueSlug) return { count: 0, commissionerPost: null };
  try{
    const snap = await withTimeout(
      db.collection('leagues').doc(store.state.account.leagueSlug).collection('trashtalk').get(),
      undefined, 'Checking trash talk');
    const since = store.state.account.lastTrashTalkSeenAt
      ? new Date(store.state.account.lastTrashTalkSeenAt) : null;
    let count = 0;
    let commissionerPost = null;
    snap.forEach(docSnap => {
      const p = { key: docSnap.id, ...docSnap.data() };
      if(store.state.account.teamName && p.teamName === store.state.account.teamName) return; // never notify on your own post
      if(since && new Date(p.postedAt) <= since) return;
      count++;
      if(p.commissioner && (!commissionerPost || new Date(p.postedAt) > new Date(commissionerPost.postedAt))){
        commissionerPost = p;
      }
    });
    return { count, commissionerPost };
  }catch(e){ return { count: 0, commissionerPost: null }; }
}

// Which Commissioner post the banner has already been dismissed for, so a
// dismiss doesn't come back on the next poll -- but a NEW recap still gets
// its own banner even if the last one was waved away unread.
let dismissedCommissionerKey = null;

/** Refreshes both badges (and the Commissioner banner) from what's unread. Safe to call often. */
export async function updateUnreadBadges(){
  const menuBadge = document.getElementById('menuUnreadBadge');
  const navBadge = document.getElementById('trashTalkNavUnreadBadge');
  const banner = document.getElementById('commissionerBanner');
  if(!menuBadge || !navBadge) return;
  const { count, commissionerPost } = await getUnreadTrashTalkInfo();

  [menuBadge, navBadge].forEach(el => {
    el.classList.toggle('has-commissioner', !!commissionerPost);
    // A football, not a number, when the news is specifically "the recap is
    // up" -- a plain count reads as "someone said something", which is easy
    // to shrug off for a week; this one shouldn't be.
    el.textContent = commissionerPost ? '🏈' : (count > 9 ? '9+' : String(count));
    el.style.display = count > 0 ? 'flex' : 'none';
  });

  if(!banner) return;
  if(commissionerPost && commissionerPost.key !== dismissedCommissionerKey){
    const textEl = document.getElementById('commissionerBannerText');
    if(textEl){
      textEl.textContent = `🏈 Commissioner Roger Goodell just posted the Week ${commissionerPost.week || ''} recap in Trash Talk.`;
    }
    banner.style.display = 'flex';
    const viewBtn = document.getElementById('commissionerBannerView');
    const dismissBtn = document.getElementById('commissionerBannerDismiss');
    if(viewBtn) viewBtn.onclick = () => {
      dismissedCommissionerKey = commissionerPost.key;
      banner.style.display = 'none';
      const navBtn = document.getElementById('navTrashTalkBtn');
      if(navBtn) navBtn.click();
    };
    if(dismissBtn) dismissBtn.onclick = () => {
      dismissedCommissionerKey = commissionerPost.key;
      banner.style.display = 'none';
    };
  } else {
    banner.style.display = 'none';
  }

  showCommissionerPopup(commissionerPost);
}

// Which Commissioner post has already popped its toast this session -- once
// per post, however many times updateUnreadBadges() happens to run (boot,
// every poll, coming back online). Dismissing it only skips it for the rest
// of this session; it's due again on the next login until it's actually read.
let poppedCommissionerKey = null;
let popupHideTimer = null;

function showCommissionerPopup(commissionerPost){
  const toast = document.getElementById('commissionerToast');
  if(!toast || !commissionerPost || commissionerPost.key === poppedCommissionerKey) return;
  poppedCommissionerKey = commissionerPost.key;

  const msgEl = document.getElementById('commissionerToastMsg');
  if(msgEl) msgEl.textContent = commissionerPost.message || '';

  const dismiss = () => {
    toast.classList.remove('show');
    setTimeout(() => { toast.style.display = 'none'; }, 320);
  };
  const closeBtn = document.getElementById('commissionerToastClose');
  if(closeBtn) closeBtn.onclick = (e) => { e.stopPropagation(); dismiss(); };
  toast.onclick = () => {
    dismiss();
    const navBtn = document.getElementById('navTrashTalkBtn');
    if(navBtn) navBtn.click();
  };

  toast.style.display = 'flex';
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(popupHideTimer);
  popupHideTimer = setTimeout(dismiss, 9000);
}

/** Call when the feed is actually opened: clears the badges going forward. */
export function markTrashTalkSeen(){
  store.state.account.lastTrashTalkSeenAt = new Date().toISOString();
  saveState();
  updateUnreadBadges();
}

