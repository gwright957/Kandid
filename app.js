const storageKeys = {
  session: 'kandid.session',
};

const API_BASE = window.__KANDID_API_BASE__ || '';

const sessionStore = {
  load() {
    try {
      const raw = window.localStorage.getItem(storageKeys.session);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.error('Failed to load session', error);
      return null;
    }
  },
  save(session) {
    try {
      if (session) {
        window.localStorage.setItem(storageKeys.session, JSON.stringify(session));
      } else {
        window.localStorage.removeItem(storageKeys.session);
      }
    } catch (error) {
      console.error('Failed to persist session', error);
    }
  },
  clear() {
    this.save(null);
  },
};

async function apiRequest(path, options = {}) {
  const config = { ...options };
  config.headers = new Headers(config.headers || {});

  if (state.session?.token) {
    config.headers.set('Authorization', `Bearer ${state.session.token}`);
  }

  if (config.body && !(config.body instanceof FormData)) {
    config.headers.set('Content-Type', 'application/json');
    if (typeof config.body !== 'string') {
      config.body = JSON.stringify(config.body);
    }
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, config);
  } catch (networkError) {
    console.error('Network error during request', networkError);
    throw new Error('Unable to reach the server. Please try again.');
  }
  if (response.status === 401) {
    performLogout(true);
    throw new Error('Session expired. Please log in again.');
  }
  if (!response.ok) {
    let message = 'Request failed.';
    try {
      const payload = await response.json();
      if (payload?.error) {
        message = payload.error;
      }
    } catch (error) {
      console.error('Failed to parse error payload', error);
    }
    throw new Error(message);
  }
  if (response.status === 204) {
    return null;
  }
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

const api = {
  login(email, password) {
    return apiRequest('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
  },
  signup(payload) {
    return apiRequest('/api/auth/signup', {
      method: 'POST',
      body: payload,
    });
  },
  fetchState() {
    return apiRequest('/api/state');
  },
  toggleFollow(userId) {
    return apiRequest(`/api/follows/${userId}/toggle`, { method: 'POST' });
  },
  createPost(payload) {
    return apiRequest('/api/posts', {
      method: 'POST',
      body: payload,
    });
  },
  toggleLike(postId) {
    return apiRequest(`/api/posts/${postId}/like`, { method: 'POST' });
  },
  addComment(postId, text) {
    return apiRequest(`/api/posts/${postId}/comments`, {
      method: 'POST',
      body: { text },
    });
  },
  toggleRepost(postId) {
    return apiRequest(`/api/posts/${postId}/repost`, { method: 'POST' });
  },
  markInboxMessages(messageIds) {
    return apiRequest('/api/inbox/mark-read', {
      method: 'POST',
      body: { messageIds },
    });
  },
  updateLocation(lat, lng) {
    return apiRequest('/api/users/me/location', {
      method: 'POST',
      body: { lat, lng },
    });
  },
};

const state = {
  users: [],
  posts: [],
  inbox: {},
  session: null,
  view: 'nearby',
  profileUserId: null,
  cameraStream: null,
  cameraImage: null,
};

function applyServerState(payload, { skipRender = false } = {}) {
  if (!payload) return;
  state.users = Array.isArray(payload.users) ? payload.users : [];
  state.posts = Array.isArray(payload.posts) ? payload.posts : [];
  state.inbox = payload.inbox && typeof payload.inbox === 'object' ? payload.inbox : {};
  if (!skipRender) {
    updateAllViews();
  }
}

async function refreshState(options = {}) {
  const data = await api.fetchState();
  applyServerState(data, options);
  return data;
}

async function updateStateFrom(requestPromise, { preserveFeedScroll = false } = {}) {
  const grid = preserveFeedScroll ? document.querySelector('#feed-grid') : null;
  const scrollTop = grid ? grid.scrollTop : 0;
  const data = await requestPromise;
  applyServerState(data);
  if (grid) {
    requestAnimationFrame(() => {
      grid.scrollTop = scrollTop;
    });
  }
  return data;
}

const selectors = {
  authMount: document.querySelector('#auth'),
  appMount: document.querySelector('#app'),
  view: {
    nearby: document.querySelector('#view-nearby'),
    feed: document.querySelector('#view-feed'),
    capture: document.querySelector('#view-capture'),
    profile: document.querySelector('#view-profile'),
    inbox: document.querySelector('#view-inbox'),
  },
  navButtons: [...document.querySelectorAll('.nav-btn[data-view]')],
  modal: {
    root: document.querySelector('#photo-modal'),
    image: document.querySelector('#lightbox-image'),
    caption: document.querySelector('#lightbox-caption'),
    meta: document.querySelector('#lightbox-meta'),
    dialog: document.querySelector('#photo-modal .lightbox__dialog'),
    closes: [...document.querySelectorAll('#photo-modal [data-close]')],
  },
};

function closePhotoModal() {
  if (!selectors.modal?.root) return;
  selectors.modal.root.classList.add('hidden');
  if (selectors.modal.image) {
    selectors.modal.image.src = '';
    selectors.modal.image.alt = 'Kandid drop';
  }
  if (selectors.modal.caption) {
    selectors.modal.caption.textContent = '';
  }
  if (selectors.modal.meta) {
    selectors.modal.meta.textContent = '';
  }
  document.body.style.overflow = '';
  document.removeEventListener('keydown', handleModalKeydown);
}

function handleModalKeydown(event) {
  if (event.key === 'Escape') {
    closePhotoModal();
  }
}

function openPhotoModal({ image, caption, meta }) {
  if (!selectors.modal?.root || !selectors.modal.image) return;
  selectors.modal.image.src = image;
  selectors.modal.image.alt = caption || 'Kandid drop';
  if (selectors.modal.caption) {
    selectors.modal.caption.textContent = caption || 'Shared a candid moment';
  }
  if (selectors.modal.meta) {
    selectors.modal.meta.textContent = meta || '';
  }
  selectors.modal.root.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', handleModalKeydown);
}

selectors.modal?.dialog?.addEventListener('click', (event) => {
  event.stopPropagation();
});

selectors.modal?.closes?.forEach((element) => {
  element.addEventListener('click', closePhotoModal);
});

selectors.modal?.root?.addEventListener('click', (event) => {
  if (event.target === selectors.modal.root) {
    closePhotoModal();
  }
});

const templates = {
  auth: document.querySelector('#auth-template'),
  nearby: document.querySelector('#nearby-template'),
  feed: document.querySelector('#feed-template'),
  capture: document.querySelector('#capture-template'),
  profile: document.querySelector('#profile-template'),
  inbox: document.querySelector('#inbox-template'),
  post: document.querySelector('#post-template'),
};

function timeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function generateAvatar(name) {
  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 200;
  const ctx = canvas.getContext('2d');
  const colors = ['#06b6d4', '#6366f1', '#ec4899', '#f97316', '#10b981'];
  const bg = colors[name.charCodeAt(0) % colors.length];
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 110px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const initials = name
    .split(' ')
    .map((part) => part[0] || '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  ctx.fillText(initials, 100, 118);
  return canvas.toDataURL('image/png');
}


function getCurrentUser() {
  if (!state.session) return null;
  return state.users.find((user) => user.id === state.session.userId) || null;
}

function performLogout(sessionExpired = false) {
  stopCamera(document.querySelector('#camera-stream'));
  closePhotoModal();
  state.session = null;
  state.profileUserId = null;
  state.users = [];
  state.posts = [];
  state.inbox = {};
  sessionStore.clear();
  selectors.appMount.classList.add('hidden');
  selectors.authMount.classList.remove('hidden');
  renderAuth();
  if (sessionExpired) {
    console.info('Session expired, prompting login');
  }
}

function renderAuth() {
  selectors.authMount.innerHTML = '';
  const clone = templates.auth.content.cloneNode(true);
  selectors.authMount.appendChild(clone);

  const loginForm = document.querySelector('#login-form');
  const signupForm = document.querySelector('#signup-form');
  const tabs = [...document.querySelectorAll('.tab')];

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const isLogin = tab.dataset.tab === 'login';
      loginForm.classList.toggle('hidden', !isLogin);
      signupForm.classList.toggle('hidden', isLogin);
    });
  });

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(loginForm);
    const email = (formData.get('email') || '').toString().trim().toLowerCase();
    const password = (formData.get('password') || '').toString();
    if (!email || !password) {
      alert('Enter your email and password.');
      return;
    }
    const submitBtn = loginForm.querySelector('button[type="submit"]');
    submitBtn?.setAttribute('disabled', 'true');
    try {
      const result = await api.login(email, password);
      state.session = { userId: result.userId, token: result.token };
      sessionStore.save(state.session);
      applyServerState(result.state, { skipRender: true });
      await showApp({ ensureFreshState: false });
    } catch (error) {
      alert(error.message || 'Failed to log in.');
    } finally {
      submitBtn?.removeAttribute('disabled');
    }
  });

  signupForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(signupForm);
    const email = (formData.get('email') || '').toString().trim().toLowerCase();
    const password = (formData.get('password') || '').toString();
    const displayName = (formData.get('displayName') || '').toString().trim();
    if (!email || !password || !displayName) {
      alert('Email, password, and display name are required.');
      return;
    }
    if (password.length < 6) {
      alert('Password must be at least 6 characters.');
      return;
    }
    const submitBtn = signupForm.querySelector('button[type="submit"]');
    submitBtn?.setAttribute('disabled', 'true');
    try {
      const avatarFile = formData.get('avatar');
      let avatar = null;
      if (avatarFile && avatarFile.size) {
        avatar = await fileToDataURL(avatarFile);
      }
      const payload = {
        email,
        password,
        displayName,
        bio: (formData.get('bio') || '').toString().trim(),
        homeCity: (formData.get('homeCity') || '').toString().trim(),
        avatar,
      };
      const result = await api.signup(payload);
      state.session = { userId: result.userId, token: result.token };
      sessionStore.save(state.session);
      applyServerState(result.state, { skipRender: true });
      await showApp({ ensureFreshState: false });
    } catch (error) {
      alert(error.message || 'Failed to create account.');
    } finally {
      submitBtn?.removeAttribute('disabled');
    }
  });
}

async function showApp({ ensureFreshState = true } = {}) {
  selectors.authMount.classList.add('hidden');
  selectors.appMount.classList.remove('hidden');
  selectors.view.nearby.innerHTML = '';
  selectors.view.feed.innerHTML = '';
  selectors.view.capture.innerHTML = '';
  selectors.view.profile.innerHTML = '';
  selectors.view.inbox.innerHTML = '';

  selectors.view.nearby.appendChild(templates.nearby.content.cloneNode(true));
  selectors.view.feed.appendChild(templates.feed.content.cloneNode(true));
  selectors.view.capture.appendChild(templates.capture.content.cloneNode(true));
  selectors.view.profile.appendChild(templates.profile.content.cloneNode(true));
  selectors.view.inbox.appendChild(templates.inbox.content.cloneNode(true));

  selectors.navButtons.forEach((btn) =>
    btn.addEventListener('click', () => {
      const targetView = btn.dataset.view;
      if (targetView === 'profile') {
        const currentUser = getCurrentUser();
        state.profileUserId = currentUser?.id || null;
      }
      switchView(targetView);
    })
  );

  const topLogout = document.querySelector('#logout-nav');
  topLogout?.addEventListener('click', performLogout);

  setupCaptureView();
  setupFeedView();
  setupNearbyView();
  setupProfileView();
  setupInboxView();
  if (ensureFreshState) {
    try {
      await refreshState({ skipRender: true });
    } catch (error) {
      console.error('Failed to refresh state', error);
    }
  }
  const sessionUser = getCurrentUser();
  state.profileUserId = sessionUser?.id || null;
  updateAllViews();

  if (sessionUser) {
    attemptGeolocation();
  }
}

function switchView(view) {
  state.view = view;
  selectors.navButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));
  Object.entries(selectors.view).forEach(([key, element]) => {
    element.classList.toggle('hidden', key !== view);
  });

  if (view !== 'capture') {
    stopCamera(document.querySelector('#camera-stream'));
    const canvas = document.querySelector('#camera-canvas');
    if (canvas) {
      canvas.classList.add('hidden');
    }
  }

  if (view === 'nearby') renderNearby();
  if (view === 'feed') renderFeed();
  if (view === 'profile') renderProfile();
  if (view === 'inbox') renderInbox();
}

function showUserProfile(userId) {
  if (!userId) return;
  state.profileUserId = userId;
  switchView('profile');
}

function bindProfileNavigation(element, userId, variant = 'text') {
  if (!element || !userId) return;
  const isText = variant === 'text';
  if (isText) {
    element.classList.add('profile-link');
    element.setAttribute('role', 'link');
  } else {
    element.classList.add('clickable');
    element.setAttribute('role', 'button');
  }
  element.tabIndex = 0;
  const openProfile = (event) => {
    if (event) {
      if (event.type === 'click') {
        event.preventDefault();
        event.stopPropagation();
      } else if (event.type === 'keydown') {
        const actionableKeys = ['Enter', ' ', 'Spacebar'];
        if (!actionableKeys.includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
      } else {
        return;
      }
    }
    showUserProfile(userId);
  };
  element.addEventListener('click', openProfile);
  element.addEventListener('keydown', openProfile);
}

function setupNearbyView() {
  const refreshBtn = document.querySelector('#refresh-nearby');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.setAttribute('disabled', 'true');
      await simulateLocationDrift();
      refreshBtn.removeAttribute('disabled');
    });
  }
}

function setupFeedView() {
  const filter = document.querySelector('#feed-filter');
  const refresh = document.querySelector('#refresh-feed');
  filter?.addEventListener('change', () => {
    renderFeed();
    document.querySelector('#feed-grid')?.scrollTo({ top: 0, behavior: 'smooth' });
  });
  refresh?.addEventListener('click', async () => {
    refresh.setAttribute('disabled', 'true');
    try {
      await refreshState();
      document.querySelector('#feed-grid')?.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      console.error('Failed to refresh feed', error);
      alert('Could not refresh the feed. Try again.');
    } finally {
      refresh.removeAttribute('disabled');
    }
  });
}

function setupCaptureView() {
  const form = document.querySelector('#capture-form');
  const fileInput = document.querySelector('#capture-file');
  const targetSelect = document.querySelector('#capture-target');
  const cameraBtn = document.querySelector('#capture-camera');
  const video = document.querySelector('#camera-stream');
  const canvas = document.querySelector('#camera-canvas');
  const captionField = document.querySelector('#capture-caption');
  const submitBtn = form?.querySelector('button[type="submit"]');

  if (!form || !targetSelect || !fileInput) {
    return;
  }

  populateTargetSelect(targetSelect);

  fileInput.addEventListener('change', () => {
    state.cameraImage = null;
    stopCamera(video);
    canvas.classList.add('hidden');
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const currentUser = getCurrentUser();
    if (!currentUser) return;

    const targetId = targetSelect.value;
    const caption = captionField?.value.trim() || '';
    const repost = document.querySelector('#capture-repost').checked;

    if (!targetId) {
      alert('Select who you spotted.');
      return;
    }

    let imageData = null;

    if (state.cameraImage) {
      imageData = state.cameraImage;
    } else {
      const file = fileInput.files[0];
      if (!file) {
        alert('Add a photo.');
        return;
      }
      imageData = await fileToDataURL(file);
    }

    submitBtn?.setAttribute('disabled', 'true');
    try {
      await updateStateFrom(
        api.createPost({
          recipientId: targetId,
          image: imageData,
          caption,
          visibility: repost ? 'public' : 'private',
        })
      );
      state.cameraImage = null;
      fileInput.value = '';
      if (captionField) captionField.value = '';
      form.reset();
      populateTargetSelect(targetSelect);
      alert('Kandid sent!');
    } catch (error) {
      console.error('Failed to send Kandid', error);
      alert(error.message || 'Failed to send Kandid.');
    } finally {
      submitBtn?.removeAttribute('disabled');
    }
  });

  cameraBtn?.addEventListener('click', async () => {
    if (state.cameraStream) {
      stopCamera(video);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      state.cameraStream = stream;
      if (video) {
        video.srcObject = stream;
        video.classList.remove('hidden');
      }
      if (canvas) {
        canvas.classList.add('hidden');
      }
      cameraBtn.textContent = 'Stop Camera';

      const shutter = document.createElement('button');
      shutter.textContent = 'Capture Photo';
      shutter.className = 'primary';
      shutter.id = 'camera-shutter';
      shutter.style.marginTop = '1rem';
      cameraBtn.parentElement.appendChild(shutter);

      shutter.addEventListener('click', () => {
        if (!video || !canvas) return;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        state.cameraImage = canvas.toDataURL('image/png');
        canvas.classList.remove('hidden');
        video.classList.add('hidden');
        stopCamera(video);
        shutter.remove();
      });
    } catch (err) {
      console.error(err);
      alert('Camera access denied. Try uploading instead.');
    }
  });
}

function stopCamera(video) {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((track) => track.stop());
    state.cameraStream = null;
  }
  if (video) {
    video.srcObject = null;
    video.classList.add('hidden');
  }
  const shutter = document.querySelector('#camera-shutter');
  if (shutter) {
    shutter.remove();
  }
  const cameraBtn = document.querySelector('#capture-camera');
  if (cameraBtn) {
    cameraBtn.textContent = 'Use Camera';
  }
}

function setupProfileView() {
  const logoutBtn = document.querySelector('#logout');
  logoutBtn?.addEventListener('click', performLogout);
  const followToggle = document.querySelector('#profile-follow-toggle');
  if (followToggle) {
    followToggle.addEventListener('click', () => {
      const targetId = followToggle.dataset.userId;
      if (!targetId) return;
      toggleFollow(targetId, followToggle);
    });
  }
}

function setupInboxView() {
  const clear = document.querySelector('#clear-inbox');
  clear?.addEventListener('click', async () => {
    const current = getCurrentUser();
    if (!current) return;
    const messages = state.inbox[current.id] || [];
    if (!messages.length) return;
    const messageIds = messages.map((message) => message.id);
    clear.setAttribute('disabled', 'true');
    try {
      await updateStateFrom(api.markInboxMessages(messageIds));
    } catch (error) {
      console.error('Failed to mark inbox messages', error);
      alert(error.message || 'Failed to mark messages as read.');
    } finally {
      clear.removeAttribute('disabled');
    }
  });
}

function populateTargetSelect(select) {
  if (!select) return;
  select.innerHTML = '';
  const option = document.createElement('option');
  option.value = '';
  option.textContent = 'Select a person';
  select.appendChild(option);

  const current = getCurrentUser();
  const candidates = state.users.filter((user) => !current || user.id !== current.id);
  candidates.forEach((user) => {
    const opt = document.createElement('option');
    opt.value = user.id;
    opt.textContent = `${user.displayName} ${user.homeCity ? `· ${user.homeCity}` : ''}`;
    select.appendChild(opt);
  });
}

function renderNearby() {
  const current = getCurrentUser();
  const list = document.querySelector('#nearby-list');
  if (!list) return;
  list.innerHTML = '';

  const others = state.users.filter((user) => !current || user.id !== current.id);

  const enriched = others.map((user) => {
    const distance = simulateDistance(current, user);
    return { user, distance };
  });

  enriched
    .sort((a, b) => a.distance - b.distance)
    .forEach(({ user, distance }) => {
      const item = document.createElement('li');
      item.className = 'list-item';

      const avatar = document.createElement('img');
      avatar.className = 'avatar';
      avatar.src = user.avatar || generateAvatar(user.displayName);
      avatar.alt = `${user.displayName} avatar`;
      bindProfileNavigation(avatar, user.id, 'avatar');

      const info = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = user.displayName;
      bindProfileNavigation(name, user.id, 'text');
      const meta = document.createElement('p');
      meta.className = 'muted';
      meta.textContent = `${user.homeCity || 'Location unknown'} • ${distance < 1 ? `${Math.round(distance * 1000)} m` : `${distance.toFixed(1)} km`} away`;

      info.appendChild(name);
      info.appendChild(meta);

      const follow = document.createElement('button');
      follow.className = 'secondary';
      follow.textContent = isFollowing(current, user.id) ? 'Following' : 'Follow';
      follow.addEventListener('click', () => toggleFollow(user.id, follow));

      item.appendChild(avatar);
      item.appendChild(info);
      if (current) {
        item.appendChild(follow);
      }

      list.appendChild(item);
    });
}

function isFollowing(current, targetId) {
  if (!current) return false;
  return current.following?.includes(targetId);
}

async function toggleFollow(targetId, button) {
  const current = getCurrentUser();
  if (!current) {
    alert('Log in to follow people.');
    return;
  }
  button?.setAttribute('disabled', 'true');
  try {
    await updateStateFrom(api.toggleFollow(targetId), { preserveFeedScroll: true });
  } catch (error) {
    console.error('Failed to toggle follow', error);
    alert(error.message || 'Failed to update follow.');
  } finally {
    button?.removeAttribute('disabled');
  }
}

function renderFeed() {
  const grid = document.querySelector('#feed-grid');
  const filter = document.querySelector('#feed-filter');
  if (!grid || !filter) return;

  grid.innerHTML = '';
  const current = getCurrentUser();
  const filterValue = filter.value;

  const visiblePosts = state.posts.filter((post) => {
    if (post.visibility !== 'public' && (!current || post.authorId !== current.id)) {
      return false;
    }
    if (filterValue === 'mine') {
      return current && post.authorId === current.id;
    }
    if (filterValue === 'following') {
      return current && current.following?.includes(post.authorId);
    }
    return true;
  });

  if (!visiblePosts.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No candid posts yet. Capture something to get started!';
    grid.appendChild(empty);
    return;
  }

  const originals = [];
  const reposts = [];

  visiblePosts
    .sort((a, b) => b.createdAt - a.createdAt)
    .forEach((post) => {
      if (post.originalPostId) {
        reposts.push(post);
      } else {
        originals.push(post);
      }
    });

  const renderSection = (posts, headingText) => {
    if (!posts.length) return;
    const heading = document.createElement('h3');
    heading.className = 'feed-section-title';
    heading.textContent = headingText;
    grid.appendChild(heading);
    posts.forEach((post) => {
      const card = templates.post.content.cloneNode(true);
      const article = card.querySelector('.post');
      if (article) {
        article.dataset.postId = post.id;
      }
      const avatarEl = card.querySelector('[data-avatar]');
      const authorEl = card.querySelector('[data-author]');
      const metaEl = card.querySelector('[data-meta]');
      const imageEl = card.querySelector('[data-image]');
      const captionEl = card.querySelector('[data-caption]');
      const likeBtn = card.querySelector('[data-like]');
      const likeCount = card.querySelector('[data-like-count]');
      const repostBtn = card.querySelector('[data-repost]');
      const followBtn = card.querySelector('[data-follow]');

      const author = state.users.find((user) => user.id === post.authorId);
      const recipient = state.users.find((user) => user.id === post.recipientId);
      if (!author) return;

      avatarEl.src = author.avatar || generateAvatar(author.displayName);
      avatarEl.alt = `${author.displayName} avatar`;
      bindProfileNavigation(avatarEl, author.id, 'avatar');

      authorEl.textContent = author.displayName;
      bindProfileNavigation(authorEl, author.id, 'text');

      if (recipient && recipient.displayName) {
        metaEl.innerHTML = `for <span data-recipient>${recipient.displayName}</span> • ${timeAgo(post.createdAt)}`;
        const recipientEl = metaEl.querySelector('[data-recipient]');
        bindProfileNavigation(recipientEl, recipient.id, 'text');
      } else {
        metaEl.textContent = `Posted ${timeAgo(post.createdAt)}`;
      }
      imageEl.src = post.image;
      captionEl.textContent = post.caption || 'Shared a candid moment';
      likeCount.textContent = post.likes.length;
      likeBtn.dataset.post = post.id;
      repostBtn.dataset.post = post.id;
      followBtn.dataset.user = author.id;
      followBtn.textContent = current && isFollowing(current, author.id) ? 'Following' : 'Follow';
      followBtn.classList.toggle('following', current && isFollowing(current, author.id));
      const isLiked = current ? post.likes.includes(current.id) : false;
      likeBtn.setAttribute('aria-pressed', isLiked);
      likeBtn.classList.toggle('is-active', isLiked);
      const isRepostAuthor = current && post.originalPostId && post.authorId === current.id;
      const isReposted = current
        ? (post.reposts || []).includes(current.id) || isRepostAuthor
        : false;
      repostBtn.setAttribute('aria-pressed', isReposted);
      repostBtn.classList.toggle('is-active', isReposted);
      repostBtn.textContent = isReposted ? '↻ Reposted' : '↻ Repost';
      repostBtn.setAttribute('aria-label', isReposted ? 'Remove repost' : 'Repost this candid');

      likeBtn.addEventListener('click', () => toggleLike(post.id));
      repostBtn.addEventListener('click', () => repost(post.id));
      followBtn.addEventListener('click', () => toggleFollow(author.id, followBtn));

      setupCommentSection(card, post, current);

      grid.appendChild(card);
    });
  };

  renderSection(originals, 'Latest Candid Posts');
  renderSection(reposts, 'Reposts');
}

function setupCommentSection(card, post, current) {
  const list = card.querySelector('[data-comment-list]');
  const form = card.querySelector('[data-comment-form]');
  const input = card.querySelector('[data-comment-input]');
  const loginNotice = card.querySelector('[data-comment-login]');
  const commentSection = card.querySelector('[data-comments]');
  const toggle = card.querySelector('[data-comment-toggle]');

  const updateToggleLabel = () => {
    if (!toggle) return;
    const count = post.comments?.length || 0;
    const collapsed = commentSection?.classList.contains('collapsed');
    toggle.textContent = `${collapsed ? 'Show' : 'Hide'} Comments (${count})`;
  };

  const refreshComments = () => {
    renderCommentList(post, list);
    updateToggleLabel();
  };

  if (commentSection) {
    commentSection.classList.add('collapsed');
  }

  refreshComments();

  toggle?.addEventListener('click', () => {
    if (!commentSection) return;
    const collapsed = commentSection.classList.toggle('collapsed');
    updateToggleLabel();
    if (!collapsed) {
      list?.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    }
  });

  if (current && form && input) {
    form.classList.remove('hidden');
    loginNotice?.classList.add('hidden');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn?.setAttribute('disabled', 'true');
      try {
        await updateStateFrom(api.addComment(post.id, text), { preserveFeedScroll: true });
        input.value = '';
        requestAnimationFrame(() => {
          const card = document.querySelector(`.post[data-post-id="${post.id}"]`);
          const section = card?.querySelector('[data-comments]');
          const updatedList = card?.querySelector('[data-comment-list]');
          if (section) {
            section.classList.remove('collapsed');
          }
          if (updatedList) {
            updatedList.scrollTop = updatedList.scrollHeight;
          }
        });
      } catch (error) {
        console.error('Failed to add comment', error);
        alert(error.message || 'Failed to add comment.');
      } finally {
        submitBtn?.removeAttribute('disabled');
      }
    });
  } else {
    form?.classList.add('hidden');
    loginNotice?.classList.remove('hidden');
  }
}

function renderCommentList(post, container) {
  if (!container) return;
  container.innerHTML = '';
  const comments = (post.comments || [])
    .slice()
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  if (!comments.length) {
    const empty = document.createElement('li');
    empty.className = 'comment-empty muted';
    empty.textContent = 'No comments yet.';
    container.appendChild(empty);
    return;
  }

  comments.forEach((comment) => {
    const item = document.createElement('li');
    item.className = 'comment-item';
    const author = state.users.find((user) => user.id === comment.authorId);
    const header = document.createElement('strong');
    header.textContent = author ? author.displayName : 'Unknown';
    if (author) {
      bindProfileNavigation(header, author.id, 'text');
    }
    const body = document.createElement('p');
    body.textContent = comment.text;
    const meta = document.createElement('p');
    meta.className = 'muted';
    meta.textContent = timeAgo(comment.createdAt || Date.now());
    item.appendChild(header);
    item.appendChild(body);
    item.appendChild(meta);
    container.appendChild(item);
  });
}

async function toggleLike(postId) {
  const current = getCurrentUser();
  if (!current) {
    alert('Log in to like posts.');
    return;
  }
  try {
    await updateStateFrom(api.toggleLike(postId), { preserveFeedScroll: true });
  } catch (error) {
    console.error('Failed to toggle like', error);
    alert(error.message || 'Failed to update like.');
  }
}

async function repost(postId) {
  const current = getCurrentUser();
  if (!current) {
    alert('Log in to repost.');
    return;
  }
  const post = state.posts.find((p) => p.id === postId);
  if (!post) return;
  const canonicalId = post.originalPostId || post.id;
  const alreadyReposted = state.posts.some(
    (candidate) => candidate.originalPostId === canonicalId && candidate.authorId === current.id
  );
  try {
    await updateStateFrom(api.toggleRepost(postId), { preserveFeedScroll: true });
    alert(alreadyReposted ? 'Repost removed.' : 'Reposted to your feed!');
  } catch (error) {
    console.error('Failed to toggle repost', error);
    alert(error.message || 'Failed to toggle repost.');
  }
}

function renderProfile() {
  const viewer = getCurrentUser();
  const defaultId = viewer?.id || (state.users[0]?.id ?? null);
  const requestedId = state.profileUserId && state.users.some((user) => user.id === state.profileUserId)
    ? state.profileUserId
    : defaultId;
  if (!requestedId) return;
  const profileUser = state.users.find((user) => user.id === requestedId);
  if (!profileUser) return;

  state.profileUserId = profileUser.id;

  const avatar = document.querySelector('#profile-avatar');
  const name = document.querySelector('#profile-name');
  const bio = document.querySelector('#profile-bio');
  const meta = document.querySelector('#profile-meta');
  const followers = document.querySelector('#profile-followers');
  const following = document.querySelector('#profile-following');
  const postsCount = document.querySelector('#profile-posts');
  const repostsCount = document.querySelector('#profile-reposts-count');
  const postsGrid = document.querySelector('#profile-posts-grid');
  const repostsGrid = document.querySelector('#profile-reposts-grid');
  const followingList = document.querySelector('#profile-following-list');
  const followToggle = document.querySelector('#profile-follow-toggle');
  const logoutBtn = document.querySelector('#logout');

  const isSelf = viewer && viewer.id === profileUser.id;

  if (logoutBtn) {
    logoutBtn.classList.toggle('hidden', !isSelf);
  }

  if (followToggle) {
    const canFollow = Boolean(viewer) && !isSelf;
    followToggle.classList.toggle('hidden', !canFollow);
    if (canFollow) {
      const currentlyFollowing = isFollowing(viewer, profileUser.id);
      followToggle.textContent = currentlyFollowing ? 'Following' : 'Follow';
      followToggle.classList.toggle('following', currentlyFollowing);
      followToggle.dataset.userId = profileUser.id;
    } else {
      followToggle.dataset.userId = '';
      followToggle.classList.remove('following');
    }
  }

  if (avatar) {
    avatar.src = profileUser.avatar || generateAvatar(profileUser.displayName);
    avatar.alt = `${profileUser.displayName} avatar`;
  }
  if (name) name.textContent = profileUser.displayName;
  if (bio) bio.textContent = profileUser.bio || 'No bio yet.';
  if (meta) meta.textContent = profileUser.homeCity ? `Based in ${profileUser.homeCity}` : 'Location not set.';
  if (followers) followers.textContent = profileUser.followers?.length || 0;
  if (following) following.textContent = profileUser.following?.length || 0;

  const originals = state.posts.filter(
    (post) =>
      post.authorId === profileUser.id &&
      !post.originalPostId &&
      (isSelf || post.visibility !== 'private')
  );
  const reposts = state.posts.filter(
    (post) =>
      post.authorId === profileUser.id &&
      post.originalPostId &&
      (isSelf || post.visibility !== 'private')
  );

  if (postsCount) postsCount.textContent = originals.length;
  if (repostsCount) repostsCount.textContent = reposts.length;

  renderProfileMedia(
    postsGrid,
    originals,
    isSelf ? 'You have not posted yet.' : `${profileUser.displayName} has not posted yet.`
  );
  renderProfileMedia(
    repostsGrid,
    reposts,
    isSelf ? 'You have not reposted yet.' : `${profileUser.displayName} has not reposted yet.`
  );

  if (followingList) {
    followingList.innerHTML = '';
    const followed = profileUser.following || [];
    if (!followed.length) {
      const empty = document.createElement('li');
      empty.className = 'muted';
      empty.textContent = isSelf
        ? 'You are not following anyone yet.'
        : `${profileUser.displayName} is not following anyone yet.`;
      empty.style.padding = '0.5rem 0';
      followingList.appendChild(empty);
    } else {
      followed.forEach((id) => {
        const user = state.users.find((u) => u.id === id);
        if (!user) return;
        const li = document.createElement('li');
        li.className = 'list-item';
        const avatarImg = document.createElement('img');
        avatarImg.src = user.avatar || generateAvatar(user.displayName);
        avatarImg.className = 'avatar';
        avatarImg.alt = `${user.displayName} avatar`;
        const block = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = user.displayName;
        const subtitle = document.createElement('p');
        subtitle.className = 'muted';
        subtitle.textContent = user.bio || 'No bio yet.';
        block.appendChild(title);
        block.appendChild(subtitle);
        li.appendChild(avatarImg);
        li.appendChild(block);
        bindProfileNavigation(li, user.id, 'card');
        followingList.appendChild(li);
      });
    }
  }
}

function renderProfileMedia(container, posts, emptyMessage) {
  if (!container) return;
  container.innerHTML = '';
  const sorted = (posts || []).slice().sort((a, b) => b.createdAt - a.createdAt);

  if (!sorted.length) {
    const empty = document.createElement('p');
    empty.className = 'profile-grid__empty';
    empty.textContent = emptyMessage;
    container.appendChild(empty);
    return;
  }

  sorted.forEach((post) => {
    const figure = document.createElement('figure');
    figure.className = 'profile-grid__item';
    figure.tabIndex = 0;
    figure.setAttribute('role', 'button');

    const img = document.createElement('img');
    img.src = post.image;
    img.alt = post.caption || 'Kandid photo';
    figure.appendChild(img);

    if (post.caption) {
      const caption = document.createElement('figcaption');
      caption.textContent = post.caption;
      figure.appendChild(caption);
    }

    const open = () => {
      const author = state.users.find((user) => user.id === post.authorId);
      const recipient = state.users.find((user) => user.id === post.recipientId);
      const original = post.originalPostId
        ? state.posts.find((candidate) => candidate.id === post.originalPostId)
        : null;
      const originalAuthor = original
        ? state.users.find((user) => user.id === original.authorId)
        : null;
      const metaParts = [];
      if (post.originalPostId) {
        metaParts.push(
          originalAuthor ? `Repost of ${originalAuthor.displayName}` : 'Repost'
        );
      } else {
        metaParts.push('Original post');
      }
      metaParts.push(`Posted ${timeAgo(post.createdAt)}`);
      if (recipient && recipient.id !== post.authorId) {
        metaParts.push(`for ${recipient.displayName}`);
      }
      openPhotoModal({
        image: post.image,
        caption: post.caption || 'Shared a candid moment',
        meta: metaParts.join(' • '),
      });
    };

    figure.addEventListener('click', open);
    figure.addEventListener('keydown', (event) => {
      if (['Enter', ' ', 'Spacebar'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        open();
      }
    });

    container.appendChild(figure);
  });
}

function renderInbox() {
  const current = getCurrentUser();
  const list = document.querySelector('#inbox-list');
  if (!current || !list) return;
  const messages = state.inbox[current.id] || [];
  list.innerHTML = '';

  if (!messages.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No direct Kandid drops yet. Capture something around you!';
    list.appendChild(empty);
    return;
  }

  messages.forEach((message) => {
    const post = state.posts.find((p) => p.id === message.postId);
    const sender = state.users.find((u) => u.id === message.senderId);
    if (!post || !sender) return;

    const item = document.createElement('li');
    item.className = 'list-item';

    const avatar = document.createElement('img');
    avatar.className = 'avatar';
    avatar.src = sender.avatar || generateAvatar(sender.displayName);
    avatar.alt = `${sender.displayName}`;
    bindProfileNavigation(avatar, sender.id, 'avatar');

    const block = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${sender.displayName} dropped you a Kandid!`;
    bindProfileNavigation(title, sender.id, 'text');
    const meta = document.createElement('p');
    meta.className = 'muted';
    meta.textContent = timeAgo(message.createdAt);

    const preview = document.createElement('img');
    preview.src = post.image;
    preview.alt = 'Kandid preview';
    preview.style.width = '84px';
    preview.style.height = '84px';
    preview.style.objectFit = 'cover';
    preview.style.borderRadius = '12px';
    preview.style.marginLeft = 'auto';

    block.appendChild(title);
    block.appendChild(meta);

    item.appendChild(avatar);
    item.appendChild(block);
    item.appendChild(preview);

    if (!message.read) {
      const badge = document.createElement('span');
      badge.textContent = 'New';
      badge.style.background = 'var(--accent)';
      badge.style.color = '#0f172a';
      badge.style.padding = '0.2rem 0.6rem';
      badge.style.borderRadius = '999px';
      badge.style.fontSize = '0.75rem';
      badge.style.marginLeft = '0.6rem';
      block.appendChild(badge);
    }

    item.style.cursor = 'pointer';
    item.title = 'Open candid';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    const openMessage = async () => {
      openPhotoModal({
        image: post.image,
        caption: post.caption || `${sender.displayName} dropped you a Kandid`,
        meta: `Sent by ${sender.displayName} • ${timeAgo(message.createdAt)}`,
      });
      if (!message.read) {
        try {
          await updateStateFrom(api.markInboxMessages([message.id]));
        } catch (error) {
          console.error('Failed to mark message as read', error);
        }
      }
    };
    item.addEventListener('click', openMessage);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openMessage();
      }
    });

    list.appendChild(item);
  });
}

function updateAllViews() {
  renderNearby();
  renderFeed();
  renderProfile();
  renderInbox();
  populateTargetSelect(document.querySelector('#capture-target'));
}

async function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

function simulateDistance(current, target) {
  const base = current?.location || {
    lat: 40.7128,
    lng: -74.006,
  };
  const targetLoc = target.location || fakeLocation(base);
  if (!target.location) {
    target.location = targetLoc;
  }
  return getDistanceFromLatLonInKm(base.lat, base.lng, targetLoc.lat, targetLoc.lng);
}

function fakeLocation(base) {
  return {
    lat: base.lat + (Math.random() - 0.5) * 0.02,
    lng: base.lng + (Math.random() - 0.5) * 0.02,
    lastUpdated: Date.now(),
  };
}

function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  const deg2rad = (deg) => deg * (Math.PI / 180);
  const R = 6371;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function simulateLocationDrift() {
  try {
    await refreshState();
  } catch (error) {
    console.error('Failed to refresh nearby list', error);
  }
}

function attemptGeolocation() {
  if (!navigator.geolocation || !state.session?.token) return;
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const { latitude, longitude } = position.coords;
      try {
        await updateStateFrom(api.updateLocation(latitude, longitude));
      } catch (error) {
        console.warn('Failed to update location', error);
      }
    },
    (error) => {
      console.warn('Geolocation denied or unavailable', error);
    },
    { enableHighAccuracy: true, timeout: 5000 }
  );
}

async function initializeApp() {
  const session = sessionStore.load();
  if (session?.token && session.userId) {
    state.session = session;
    selectors.authMount.classList.add('hidden');
    selectors.appMount.classList.remove('hidden');
    try {
      await showApp({ ensureFreshState: true });
    } catch (error) {
      console.error('Failed to restore session', error);
      performLogout();
      alert('We could not restore your session. Please log in again.');
    }
  } else {
    selectors.appMount.classList.add('hidden');
    selectors.authMount.classList.remove('hidden');
    renderAuth();
  }
}

initializeApp();
