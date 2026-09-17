'use strict';

/* =========================================================
   NICK & JUDY WORLD
   Main application file
========================================================= */

const C = window.APP_CONFIG;

if (
  !C ||
  !C.SUPABASE_URL ||
  !C.SUPABASE_KEY ||
  C.SUPABASE_URL.includes('PASTE_') ||
  C.SUPABASE_KEY.includes('PASTE_')
) {
  alert(
    'Supabase is not configured correctly. Please check config.js.'
  );

  throw new Error('Missing or invalid Supabase configuration.');
}

if (!window.supabase) {
  alert(
    'The Supabase library did not load. Please refresh the page and check your internet connection.'
  );

  throw new Error('Supabase library is unavailable.');
}

const sb = window.supabase.createClient(
  C.SUPABASE_URL,
  C.SUPABASE_KEY
);

let section = 'dashboard';
let entries = [];
let currentUser = null;

const sections = [
  ['dashboard', '⌂ Dashboard'],
  ['plan', '⌁ Future Plans'],
  ['discussion', '◌ Discussions'],
  ['game', '♟ Couple Games'],
  ['decision', '✓ Decisions'],
  ['memory', '◇ Memories & Photos'],
  ['bucket', '☆ Bucket List'],
  ['date', '◷ Important Dates'],
  ['letter', '✉ Letters'],
  ['journal', '☷ Shared Journal'],
  ['dateidea', '♡ Date Ideas']
];

/* =========================================================
   GENERAL HELPERS
========================================================= */

function getElement(id) {
  return document.getElementById(id);
}

function toast(message) {
  const toastElement = getElement('toast');

  if (!toastElement) {
    console.log(message);
    return;
  }

  toastElement.textContent = message;
  toastElement.style.display = 'block';

  window.clearTimeout(toastElement.toastTimer);

  toastElement.toastTimer = window.setTimeout(() => {
    toastElement.style.display = 'none';
  }, 3000);
}

function escapeHtml(value = '') {
  return String(value).replace(
    /[&<>"']/g,
    character =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
      })[character]
  );
}

function escapeAttribute(value = '') {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function calculateDays(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime())
  ) {
    return 0;
  }

  const difference = end.getTime() - start.getTime();

  return Math.max(
    0,
    Math.ceil(difference / 86400000)
  );
}

function formatDate(dateValue) {
  if (!dateValue) {
    return '';
  }

  const date = new Date(`${dateValue}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return dateValue;
  }

  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

/* =========================================================
   AUTHENTICATION
========================================================= */

async function signup() {
  const emailElement = getElement('email');
  const passwordElement = getElement('password');

  const emailValue = emailElement?.value.trim() || '';
  const passwordValue = passwordElement?.value || '';

  if (!emailValue || !passwordValue) {
    toast('Enter both email and password.');
    return;
  }

  if (passwordValue.length < 6) {
    toast('The password must contain at least 6 characters.');
    return;
  }

  try {
    const { data, error } = await sb.auth.signUp({
      email: emailValue,
      password: passwordValue
    });

    if (error) {
      throw error;
    }

    if (data.session) {
      toast('Account created and signed in.');
      await initializeApplication();
      return;
    }

    toast(
      'Account created. Please check your email and confirm the account before signing in.'
    );
  } catch (error) {
    console.error('Signup error:', error);
    toast(`Signup error: ${error.message}`);
  }
}

async function login() {
  const emailElement = getElement('email');
  const passwordElement = getElement('password');
  const loginButton = getElement('loginButton');

  const emailValue = emailElement?.value.trim() || '';
  const passwordValue = passwordElement?.value || '';

  if (!emailValue || !passwordValue) {
    toast('Enter both email and password.');
    return;
  }

  try {
    if (loginButton) {
      loginButton.disabled = true;
      loginButton.textContent = 'Opening our universe...';
    }

    const { data, error } =
      await sb.auth.signInWithPassword({
        email: emailValue,
        password: passwordValue
      });

    if (error) {
      throw error;
    }

    if (!data.session) {
      toast(
        'No login session was created. Please confirm your email account.'
      );
      return;
    }

    toast('Welcome back 💛');

    await initializeApplication();
  } catch (error) {
    console.error('Login error:', error);

    if (
      String(error.message)
        .toLowerCase()
        .includes('email not confirmed')
    ) {
      toast(
        'Please confirm the account using the email sent by Supabase.'
      );
    } else {
      toast(`Login failed: ${error.message}`);
    }
  } finally {
    if (loginButton) {
      loginButton.disabled = false;
      loginButton.textContent = 'Enter our universe';
    }
  }
}

async function logout() {
  try {
    const { error } = await sb.auth.signOut();

    if (error) {
      throw error;
    }

    currentUser = null;
    entries = [];

    getElement('app').hidden = true;
    getElement('auth').hidden = false;

    const passwordElement = getElement('password');

    if (passwordElement) {
      passwordElement.value = '';
    }

    toast('Signed out successfully.');
  } catch (error) {
    console.error('Logout error:', error);
    toast(`Sign-out error: ${error.message}`);
  }
}

/* =========================================================
   APPLICATION INITIALIZATION
========================================================= */

async function initializeApplication() {
  try {
    const {
      data: { user },
      error
    } = await sb.auth.getUser();

    if (error) {
      throw error;
    }

    if (!user) {
      getElement('app').hidden = true;
      getElement('auth').hidden = false;

      toast('No active session was found.');
      return;
    }

    currentUser = user;

    getElement('auth').hidden = true;
    getElement('app').hidden = false;

    buildNavigation();
    buildEntryTypeOptions();

    await loadEntries();

    show('dashboard');
  } catch (error) {
    console.error(
      'Application initialization error:',
      error
    );

    getElement('app').hidden = true;
    getElement('auth').hidden = false;

    toast(`Dashboard loading error: ${error.message}`);
  }
}

function buildNavigation() {
  const navigation = getElement('nav');

  if (!navigation) {
    return;
  }

  navigation.innerHTML = sections
    .map(
      item => `
        <button
          type="button"
          data-section="${escapeHtml(item[0])}"
          onclick="show('${escapeAttribute(item[0])}')"
        >
          ${escapeHtml(item[1])}
        </button>
      `
    )
    .join('');
}

function buildEntryTypeOptions() {
  const typeSelect = getElement('fType');

  if (!typeSelect) {
    return;
  }

  typeSelect.innerHTML = sections
    .slice(1)
    .filter(
      item =>
        !['discussion', 'game'].includes(item[0])
    )
    .map(
      item => `
        <option value="${escapeHtml(item[0])}">
          ${escapeHtml(
            item[1].replace(/^[^\s]+\s/, '')
          )}
        </option>
      `
    )
    .join('');
}

/* =========================================================
   DATABASE
========================================================= */

async function loadEntries() {
  try {
    const { data, error } = await sb
      .from('entries')
      .select('*')
      .eq('archived', false)
      .order('created_at', {
        ascending: false
      });

    if (error) {
      throw error;
    }

    entries = data || [];
  } catch (error) {
    console.error('Entries loading error:', error);
    entries = [];
    toast(`Could not load entries: ${error.message}`);
  }
}

/* =========================================================
   NAVIGATION AND PAGES
========================================================= */

function show(selectedSection) {
  section = selectedSection;

  document.body.classList.remove('open');

  const selectedSectionInfo = sections.find(
    item => item[0] === selectedSection
  );

  const title = selectedSectionInfo
    ? selectedSectionInfo[1].replace(/^[^\s]+\s/, '')
    : selectedSection;

  const pageTitle = getElement('pageTitle');

  if (pageTitle) {
    pageTitle.textContent = title;
  }

  document
    .querySelectorAll('#nav button')
    .forEach(button => {
      button.classList.toggle(
        'active',
        button.dataset.section === selectedSection
      );
    });

  if (selectedSection === 'dashboard') {
    renderDashboard();
    return;
  }

  if (
    selectedSection === 'discussion' ||
    selectedSection === 'game'
  ) {
    renderPromptCategories(selectedSection);
    return;
  }

  renderEntryList(selectedSection);
}

/* =========================================================
   DASHBOARD
========================================================= */

function renderDashboard() {
  const content = getElement('content');

  if (!content) {
    return;
  }

  const daysUntilMeeting = calculateDays(
    new Date(),
    C.NEXT_MEET_DATE
  );

  const daysTogether = calculateDays(
    C.RELATIONSHIP_START,
    new Date()
  );

  const activePlans = entries
    .filter(entry => entry.type === 'plan')
    .slice(0, 6);

  content.innerHTML = `
    <section class="hero">
      <small>WELCOME TO</small>

      <h1>Nick &amp; Judy World</h1>

      <p>
        Building our next chapter with intention,
        laughter and barakah.
      </p>
    </section>

    <section class="stats">
      <div class="stat">
        <small>NEXT MEETING</small>

        <b>
          ${daysUntilMeeting}
          ${daysUntilMeeting === 1 ? 'day' : 'days'}
        </b>
      </div>

      <div class="stat">
        <small>DAYS TOGETHER</small>

        <b>${daysTogether}</b>
      </div>

      <div class="stat">
        <small>SHARED ITEMS</small>

        <b>${entries.length}</b>
      </div>
    </section>

    <h2>Our current chapter</h2>

    <section class="grid">
      ${renderCards(activePlans)}
    </section>
  `;
}

/* =========================================================
   CARDS AND LISTS
========================================================= */

function renderCards(items) {
  if (!items.length) {
    return `
      <div class="empty">
        Nothing here yet. Use “Add” to begin.
      </div>
    `;
  }

  return items
    .map(entry => {
      const status =
        entry.status ||
        (entry.completed
          ? 'Completed'
          : 'Idea');

      return `
        <article class="card">
          <span class="pill">
            ${escapeHtml(
              entry.category || entry.type
            )}
          </span>

          <span class="pill">
            ${escapeHtml(status)}
          </span>

          <h3>${escapeHtml(entry.title)}</h3>

          <p>
            ${escapeHtml(
              entry.details ||
                'Ready for your notes and checklist.'
            )}
          </p>

          ${
            entry.target_date
              ? `
                <small>
                  Target: ${escapeHtml(
                    formatDate(entry.target_date)
                  )}
                </small>
              `
              : ''
          }

          ${
            entry.budget
              ? `
                <small>
                  Budget: ${escapeHtml(entry.budget)}
                </small>
              `
              : ''
          }

          <div class="actions">
            <button
              type="button"
              class="light"
              onclick="toggleDone(
                '${escapeAttribute(entry.id)}',
                ${!entry.completed}
              )"
            >
              ${
                entry.completed
                  ? 'Reopen'
                  : 'Complete'
              }
            </button>

            <button
              type="button"
              class="light"
              onclick="archiveEntry(
                '${escapeAttribute(entry.id)}'
              )"
            >
              Archive
            </button>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderEntryList(type) {
  const content = getElement('content');

  if (!content) {
    return;
  }

  const typeEntries = entries.filter(
    entry => entry.type === type
  );

  const categories = [
    ...new Set(
      typeEntries
        .map(entry => entry.category)
        .filter(Boolean)
    )
  ];

  content.innerHTML = `
    <div class="filters">
      <button
        type="button"
        class="active"
        onclick="filterCards(this, '${escapeAttribute(type)}', '')"
      >
        All
      </button>

      ${categories
        .map(
          category => `
            <button
              type="button"
              onclick="filterCards(
                this,
                '${escapeAttribute(type)}',
                '${escapeAttribute(category)}'
              )"
            >
              ${escapeHtml(category)}
            </button>
          `
        )
        .join('')}
    </div>

    <section class="grid" id="cards">
      ${renderCards(typeEntries)}
    </section>
  `;
}

function filterCards(button, type, category) {
  document
    .querySelectorAll('.filters button')
    .forEach(filterButton => {
      filterButton.classList.remove('active');
    });

  button.classList.add('active');

  const filteredEntries = entries.filter(
    entry =>
      entry.type === type &&
      (!category || entry.category === category)
  );

  const cardsContainer = getElement('cards');

  if (cardsContainer) {
    cardsContainer.innerHTML =
      renderCards(filteredEntries);
  }
}

/* =========================================================
   DISCUSSIONS AND GAMES
========================================================= */

async function renderPromptCategories(kind) {
  const content = getElement('content');

  if (!content) {
    return;
  }

  try {
    const completionField =
      kind === 'discussion'
        ? 'discussed'
        : 'used';

    const { data, error } = await sb
      .from('prompts')
      .select('*')
      .eq('kind', kind)
      .eq(completionField, false);

    if (error) {
      throw error;
    }

    const availablePrompts = data || [];

    const categories = [
      ...new Set(
        availablePrompts.map(
          prompt => prompt.category
        )
      )
    ];

    if (!categories.length) {
      content.innerHTML = `
        <div class="card empty">
          <h3>Everything is complete 🎉</h3>

          <p>
            There are no unused prompts left in this
            section.
          </p>
        </div>
      `;

      return;
    }

    content.innerHTML = `
      <div class="filters">
        ${categories
          .map(
            (category, index) => `
              <button
                type="button"
                class="${index === 0 ? 'active' : ''}"
                onclick="selectPromptCategory(
                  this,
                  '${escapeAttribute(kind)}',
                  '${escapeAttribute(category)}'
                )"
              >
                ${escapeHtml(category)}
              </button>
            `
          )
          .join('')}
      </div>

      <div
        id="promptArea"
        class="card empty"
      >
        Choose a category to draw a fresh prompt.
      </div>
    `;

    await newPrompt(kind, categories[0]);
  } catch (error) {
    console.error('Prompt loading error:', error);

    content.innerHTML = `
      <div class="card empty">
        Could not load the prompts.
      </div>
    `;

    toast(`Prompt loading error: ${error.message}`);
  }
}

async function selectPromptCategory(
  button,
  kind,
  category
) {
  document
    .querySelectorAll('.filters button')
    .forEach(filterButton => {
      filterButton.classList.remove('active');
    });

  button.classList.add('active');

  await newPrompt(kind, category);
}

async function newPrompt(kind, category) {
  const promptArea = getElement('promptArea');

  if (!promptArea) {
    return;
  }

  try {
    const completionField =
      kind === 'discussion'
        ? 'discussed'
        : 'used';

    const { data, error } = await sb
      .from('prompts')
      .select('*')
      .eq('kind', kind)
      .eq('category', category)
      .eq(completionField, false);

    if (error) {
      throw error;
    }

    if (!data || !data.length) {
      promptArea.className = 'card empty';

      promptArea.innerHTML = `
        <h3>
          All prompts in this category are complete 🎉
        </h3>
      `;

      return;
    }

    const selectedPrompt =
      data[
        Math.floor(Math.random() * data.length)
      ];

    promptArea.className = 'card';

    if (kind === 'discussion') {
      promptArea.innerHTML = `
        <span class="pill">
          ${escapeHtml(category)}
        </span>

        <p class="prompt">
          ${escapeHtml(selectedPrompt.question)}
        </p>

        <textarea
          id="conclusion"
          placeholder="Optional agreed conclusion or note"
        ></textarea>

        <div class="actions">
          <button
            type="button"
            onclick="finishPrompt(
              ${selectedPrompt.id},
              'discussion'
            )"
          >
            Mark discussed
          </button>

          <button
            type="button"
            class="light"
            onclick="newPrompt(
              'discussion',
              '${escapeAttribute(category)}'
            )"
          >
            Another topic
          </button>
        </div>
      `;
    } else {
      promptArea.innerHTML = `
        <span class="pill">
          ${escapeHtml(category)}
        </span>

        <p class="prompt">
          ${escapeHtml(selectedPrompt.question)}
        </p>

        <div class="answerbox">
          <textarea
            id="nickAnswer"
            placeholder="Nick's answer"
          ></textarea>

          <textarea
            id="judyAnswer"
            placeholder="Judy's answer"
          ></textarea>
        </div>

        <div class="actions">
          <button
            type="button"
            onclick="finishPrompt(
              ${selectedPrompt.id},
              'game'
            )"
          >
            Finish and do not repeat
          </button>

          <button
            type="button"
            class="light"
            onclick="newPrompt(
              'game',
              '${escapeAttribute(category)}'
            )"
          >
            Another game
          </button>
        </div>

        <small>
          Game answers remain on the screen only and
          are not permanently stored.
        </small>
      `;
    }
  } catch (error) {
    console.error('New prompt error:', error);
    toast(`Could not load a prompt: ${error.message}`);
  }
}

async function finishPrompt(id, kind) {
  try {
    if (kind === 'discussion') {
      const conclusionElement =
        getElement('conclusion');

      const conclusion =
        conclusionElement?.value.trim() || '';

      if (conclusion) {
        const { error: conclusionError } = await sb
          .from('entries')
          .insert({
            type: 'decision',
            category: 'Discussion conclusion',
            title: 'Agreed conclusion',
            details: conclusion,
            created_by: currentUser.id,
            status: 'Agreed'
          });

        if (conclusionError) {
          throw conclusionError;
        }
      }
    }

    const update =
      kind === 'discussion'
        ? { discussed: true }
        : { used: true };

    const { error } = await sb
      .from('prompts')
      .update(update)
      .eq('id', id);

    if (error) {
      throw error;
    }

    toast(
      kind === 'discussion'
        ? 'Discussion saved and marked complete.'
        : 'Game completed and removed from future draws.'
    );

    await renderPromptCategories(kind);
  } catch (error) {
    console.error('Finish prompt error:', error);
    toast(`Could not save the result: ${error.message}`);
  }
}

/* =========================================================
   ADDING AND EDITING SHARED ITEMS
========================================================= */

function openAdd() {
  const modal = getElement('modal');

  if (modal) {
    modal.showModal();
  }
}

function closeAddModal() {
  const modal = getElement('modal');

  if (modal?.open) {
    modal.close();
  }
}

async function saveEntry(event) {
  event.preventDefault();

  if (!currentUser) {
    toast('Please sign in again.');
    return;
  }

  const form = getElement('entryForm');
  const saveButton =
    form?.querySelector('button[type="submit"]');

  const type = getElement('fType')?.value || '';
  const title =
    getElement('fTitle')?.value.trim() || '';
  const category =
    getElement('fCategory')?.value.trim() || '';
  const details =
    getElement('fDetails')?.value.trim() || '';
  const status =
    getElement('fStatus')?.value || 'Idea';
  const targetDate =
    getElement('fDate')?.value || null;
  const budget =
    getElement('fBudget')?.value || null;
  const photo =
    getElement('fPhoto')?.files?.[0] || null;

  if (!title) {
    toast('Please enter a title.');
    return;
  }

  try {
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.textContent = 'Saving...';
    }

    const payload = {
      type,
      title,
      category: category || null,
      details: details || null,
      status,
      target_date: targetDate,
      budget,
      created_by: currentUser.id
    };

    const {
      data: newEntry,
      error: entryError
    } = await sb
      .from('entries')
      .insert(payload)
      .select()
      .single();

    if (entryError) {
      throw entryError;
    }

    if (photo) {
      const safeFileName = photo.name.replace(
        /[^a-zA-Z0-9._-]/g,
        '_'
      );

      const filePath =
        `${currentUser.id}/` +
        `${Date.now()}-${safeFileName}`;

      const { error: uploadError } =
        await sb.storage
          .from('our-universe')
          .upload(filePath, photo);

      if (uploadError) {
        throw uploadError;
      }

      const { error: mediaError } = await sb
        .from('media')
        .insert({
          entry_id: newEntry.id,
          path: filePath,
          uploaded_by: currentUser.id
        });

      if (mediaError) {
        throw mediaError;
      }
    }

    closeAddModal();
    form.reset();

    await loadEntries();
    show(section);

    toast('Saved permanently 💛');
  } catch (error) {
    console.error('Saving error:', error);
    toast(`Could not save the item: ${error.message}`);
  } finally {
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = 'Save permanently';
    }
  }
}

async function toggleDone(id, completed) {
  try {
    const { error } = await sb
      .from('entries')
      .update({
        completed,
        status: completed
          ? 'Completed'
          : 'In Progress',
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (error) {
      throw error;
    }

    await loadEntries();
    show(section);

    toast(
      completed
        ? 'Marked as completed.'
        : 'Item reopened.'
    );
  } catch (error) {
    console.error('Completion update error:', error);

    toast(
      `Could not update the item: ${error.message}`
    );
  }
}

async function archiveEntry(id) {
  const approved = window.confirm(
    'Archive this item? It will be hidden but not permanently deleted.'
  );

  if (!approved) {
    return;
  }

  try {
    const { error } = await sb
      .from('entries')
      .update({
        archived: true,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (error) {
      throw error;
    }

    await loadEntries();
    show(section);

    toast('Item archived.');
  } catch (error) {
    console.error('Archive error:', error);

    toast(
      `Could not archive the item: ${error.message}`
    );
  }
}

/* =========================================================
   BUTTON CONNECTIONS
========================================================= */

function connectPageButtons() {
  getElement('loginButton')
    ?.addEventListener('click', login);

  getElement('signupButton')
    ?.addEventListener('click', signup);

  getElement('logoutButton')
    ?.addEventListener('click', logout);

  getElement('addButton')
    ?.addEventListener('click', openAdd);

  getElement('closeModalButton')
    ?.addEventListener('click', closeAddModal);

  getElement('menuButton')
    ?.addEventListener('click', () => {
      document.body.classList.toggle('open');
    });

  getElement('entryForm')
    ?.addEventListener('submit', saveEntry);

  getElement('password')
    ?.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        login();
      }
    });
}

/* =========================================================
   EXPOSE FUNCTIONS USED BY GENERATED BUTTONS
========================================================= */

window.login = login;
window.signup = signup;
window.logout = logout;
window.show = show;
window.openAdd = openAdd;
window.closeAddModal = closeAddModal;
window.saveEntry = saveEntry;
window.filterCards = filterCards;
window.selectPromptCategory =
  selectPromptCategory;
window.newPrompt = newPrompt;
window.finishPrompt = finishPrompt;
window.toggleDone = toggleDone;
window.archiveEntry = archiveEntry;

/* =========================================================
   START THE APPLICATION
========================================================= */

document.addEventListener(
  'DOMContentLoaded',
  async () => {
    connectPageButtons();

    try {
      const {
        data: { session },
        error
      } = await sb.auth.getSession();

      if (error) {
        throw error;
      }

      if (session) {
        await initializeApplication();
      }
    } catch (error) {
      console.error(
        'Initial session loading error:',
        error
      );

      toast(
        `Session loading error: ${error.message}`
      );
    }
  }
);
