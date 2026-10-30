// public/js/app.js
// Main Application Controller for Apex Internet Banking

class BankingApp {
  constructor() {
    this.accounts = [];
    this.transactions = [];
    this.notifications = [];
    this.currentFilter = 'ALL';
    this.isBalanceHidden = false;
    this.activeCard = null;

    this.initElements();
    this.initEventListeners();
    this.bootstrapSession();
  }

  initElements() {
    this.totalNetWorthEl = document.getElementById('totalNetWorth');
    this.accountsListEl = document.getElementById('accountsList');
    this.accountCountBadgeEl = document.getElementById('accountCountBadge');
    this.transactionsTableBodyEl = document.getElementById('transactionsTableBody');
    this.notifBadgeEl = document.getElementById('notifBadge');
    this.notifListEl = document.getElementById('notifList');
    this.notifDropdownEl = document.getElementById('notifDropdown');
    this.toastContainerEl = document.getElementById('toastContainer');
    this.personaSelector = document.getElementById('personaSelector');

    // Modals
    this.transferModal = document.getElementById('transferModal');
    this.depositModal = document.getElementById('depositModal');
    this.newAccountModal = document.getElementById('newAccountModal');
    this.sagaAuditModal = document.getElementById('sagaAuditModal');
    this.authModal = document.getElementById('authModal');

    // Auth Elements
    this.signOutBtn = document.getElementById('signOutBtn');
    this.openAuthBtn = document.getElementById('openAuthBtn');
    this.tabSignInBtn = document.getElementById('tabSignInBtn');
    this.tabRegisterBtn = document.getElementById('tabRegisterBtn');
    this.signInForm = document.getElementById('signInForm');
    this.registerForm = document.getElementById('registerForm');
    this.closeAuthModalBtn = document.getElementById('closeAuthModal');

    // Forms & Inputs
    this.transferForm = document.getElementById('transferForm');
    this.transferFromSelect = document.getElementById('transferFromAccount');
    this.sourceBalanceHint = document.getElementById('sourceBalanceHint');
    this.transferToInput = document.getElementById('transferToAccount');
    this.transferAmountInput = document.getElementById('transferAmount');
    this.transferPinInput = document.getElementById('transferPin');

    // Card Elements
    this.creditCardEl = document.getElementById('creditCard');
    this.cardNumberDisplay = document.getElementById('cardNumberDisplay');
    this.cardHolderDisplay = document.getElementById('cardHolderNameDisplay');
    this.cardExpiryDisplay = document.getElementById('cardExpiryDisplay');
    this.cardCvvDisplay = document.getElementById('cardCvvDisplay');
    this.cardLockToggle = document.getElementById('cardLockToggle');
    this.cardOnlineToggle = document.getElementById('cardOnlineToggle');
  }

  initEventListeners() {
    // View Switcher (Customer vs Ops)
    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const targetView = btn.dataset.view;
        document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        document.querySelectorAll('.view-container').forEach(v => v.classList.remove('active'));
        if (targetView === 'customer') {
          document.getElementById('customerView').classList.add('active');
        } else {
          document.getElementById('opsView').classList.add('active');
          window.opsDashboard?.loadTopology();
          window.opsDashboard?.loadFraudAlerts();
        }
      });
    });

    // Mesh status pill jumps to Ops view
    document.getElementById('globalMeshStatus')?.addEventListener('click', () => {
      document.querySelector('.view-btn[data-view="ops"]')?.click();
    });

    // Persona Switcher
    this.personaSelector?.addEventListener('change', (e) => {
      if (e.target.value === 'auth') {
        this.openAuthModal('signin');
      } else {
        this.switchPersona(e.target.value);
      }
    });

    // Notification dropdown toggle
    document.getElementById('notifBellBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.notifDropdownEl.classList.toggle('hidden');
    });

    document.addEventListener('click', () => {
      this.notifDropdownEl?.classList.add('hidden');
    });

    this.notifDropdownEl?.addEventListener('click', (e) => e.stopPropagation());
    document.getElementById('markAllReadBtn')?.addEventListener('click', () => this.markAllNotificationsRead());

    // Balance privacy toggle
    document.getElementById('toggleBalanceVisibility')?.addEventListener('click', () => {
      this.isBalanceHidden = !this.isBalanceHidden;
      this.renderNetWorth();
    });

    // Virtual Card 3D Flip to see CVV
    this.creditCardEl?.addEventListener('click', () => {
      const front = this.creditCardEl.querySelector('.card-front');
      const back = this.creditCardEl.querySelector('.card-back');
      front.classList.toggle('hidden');
      back.classList.toggle('hidden');
    });

    // Card Lock Switch
    this.cardLockToggle?.addEventListener('change', async (e) => {
      if (!this.activeCard) return;
      const newStatus = e.target.checked ? 'FROZEN' : 'ACTIVE';
      try {
        await window.api.toggleCardLock(this.activeCard.id, newStatus);
        this.activeCard.status = newStatus;
        this.creditCardEl.classList.toggle('frozen', newStatus === 'FROZEN');
        this.showToast(`Card status updated to ${newStatus}`, 'INFO');
      } catch (err) {
        this.showToast(`Failed to update card: ${err.message}`, 'ERROR');
        e.target.checked = !e.target.checked;
      }
    });

    // Card Online purchases Switch
    this.cardOnlineToggle?.addEventListener('change', async (e) => {
      if (!this.activeCard) return;
      try {
        await window.api.updateCardSettings(this.activeCard.id, { onlinePurchases: e.target.checked });
        this.showToast(`Online card purchases: ${e.target.checked ? 'Enabled' : 'Disabled'}`, 'INFO');
      } catch (err) {
        this.showToast(`Error: ${err.message}`, 'ERROR');
      }
    });

    // Filter Chips for Ledger
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.currentFilter = chip.dataset.filter;
        this.renderTransactions();
      });
    });

    // Modal Triggers
    document.getElementById('openSendMoneyBtn')?.addEventListener('click', () => this.openTransferModal());
    document.getElementById('closeTransferModal')?.addEventListener('click', () => this.closeTransferModal());
    document.getElementById('cancelTransferBtn')?.addEventListener('click', () => this.closeTransferModal());

    document.getElementById('openDepositBtn')?.addEventListener('click', () => this.openDepositModal());
    document.getElementById('closeDepositModal')?.addEventListener('click', () => this.closeDepositModal());
    document.getElementById('cancelDepositBtn')?.addEventListener('click', () => this.closeDepositModal());

    document.getElementById('openNewAccountBtn')?.addEventListener('click', () => this.newAccountModal.classList.remove('hidden'));
    document.getElementById('closeNewAccountModal')?.addEventListener('click', () => this.newAccountModal.classList.add('hidden'));
    document.getElementById('cancelNewAccountBtn')?.addEventListener('click', () => this.newAccountModal.classList.add('hidden'));

    document.getElementById('closeSagaAuditModal')?.addEventListener('click', () => this.sagaAuditModal.classList.add('hidden'));

    // Quick pick recipient
    document.getElementById('quickPickSarahBtn')?.addEventListener('click', () => {
      this.transferToInput.value = '4055239912'; // Sarah Connor
    });

    // Amount Pills
    document.querySelectorAll('.amount-pills .pill').forEach(pill => {
      pill.addEventListener('click', () => {
        this.transferAmountInput.value = pill.dataset.amount;
      });
    });

    // Source account change update balance hint
    this.transferFromSelect?.addEventListener('change', () => this.updateSourceBalanceHint());

    // Submit Transfer (Saga)
    this.transferForm?.addEventListener('submit', (e) => this.handleTransferSubmit(e));

    // Submit Deposit
    document.getElementById('depositForm')?.addEventListener('submit', (e) => this.handleDepositSubmit(e));

    // Submit New Account
    document.getElementById('newAccountForm')?.addEventListener('submit', (e) => this.handleNewAccountSubmit(e));

    // Export CSV
    document.getElementById('exportCsvBtn')?.addEventListener('click', () => this.exportCsvStatement());

    // Auth Listeners
    this.signOutBtn?.addEventListener('click', () => this.handleSignOut());
    this.openAuthBtn?.addEventListener('click', () => this.openAuthModal('signin'));
    this.closeAuthModalBtn?.addEventListener('click', () => this.closeAuthModal());
    this.tabSignInBtn?.addEventListener('click', () => this.switchAuthTab('signin'));
    this.tabRegisterBtn?.addEventListener('click', () => this.switchAuthTab('register'));
    this.signInForm?.addEventListener('submit', (e) => this.handleSignInSubmit(e));
    this.registerForm?.addEventListener('submit', (e) => this.handleRegisterSubmit(e));
  }

  // Session Initialization
  async bootstrapSession() {
    const urlParams = new URLSearchParams(window.location.search);
    const forceAuth = urlParams.get('auth') === 'true' || urlParams.get('logout') === 'true';

    if (forceAuth) {
      this.handleSignOut();
      return;
    }

    // If a valid saved user exists in session/localStorage, restore it
    if (window.api.token && window.api.currentUser) {
      this.updateAuthUI(window.api.currentUser);
      await this.refreshUserData();
      this.startNotificationStream();
    } else {
      // If not logged in, present the Sign In & Register modal immediately!
      this.updateAuthUI(null);
      this.openAuthModal('signin');
    }
  }

  updateAuthUI(user) {
    const userPill = document.getElementById('userPill');
    const userName = document.getElementById('userName');
    const userAvatar = document.getElementById('userAvatar');
    const userRole = document.getElementById('userRole');

    if (user) {
      this.signOutBtn?.classList.remove('hidden');
      if (this.openAuthBtn) {
        this.openAuthBtn.classList.remove('hidden');
        this.openAuthBtn.innerHTML = '<span>Switch / Register</span>';
        this.openAuthBtn.className = 'btn btn-sm btn-secondary';
      }
      if (userPill) userPill.classList.remove('hidden');

      if (userName) userName.textContent = user.fullName;
      if (userAvatar) userAvatar.textContent = user.fullName.split(' ').map(n => n[0]).join('').slice(0, 2);
      if (userRole) {
        userRole.textContent = user.role === 'admin' ? 'Compliance Auditor' : 'Verified Customer';
      }

      // Sync persona dropdown if matching
      if (this.personaSelector) {
        if (user.email.includes('john')) this.personaSelector.value = 'john';
        else if (user.email.includes('sarah')) this.personaSelector.value = 'sarah';
        else if (user.email.includes('admin')) this.personaSelector.value = 'admin';
        else this.personaSelector.value = 'auth';
      }
    } else {
      this.signOutBtn?.classList.add('hidden');
      if (this.openAuthBtn) {
        this.openAuthBtn.classList.remove('hidden');
        this.openAuthBtn.innerHTML = '<span>Sign In / Register</span>';
        this.openAuthBtn.className = 'btn btn-sm btn-primary';
      }
      if (userName) userName.textContent = 'Not Signed In';
      if (userAvatar) userAvatar.textContent = '??';
      if (userRole) userRole.textContent = 'Guest';

      if (this.personaSelector) {
        this.personaSelector.value = 'auth';
      }

      this.accounts = [];
      this.transactions = [];
      this.renderAccounts();
      this.renderNetWorth();
      this.renderTransactions();
    }
  }

  openAuthModal(tab = 'signin') {
    this.switchAuthTab(tab);
    this.authModal?.classList.remove('hidden');
  }

  closeAuthModal() {
    this.authModal?.classList.add('hidden');
  }

  switchAuthTab(tab) {
    if (tab === 'signin') {
      this.tabSignInBtn?.classList.add('active');
      this.tabRegisterBtn?.classList.remove('active');
      this.signInForm?.classList.remove('hidden');
      this.registerForm?.classList.add('hidden');
      document.getElementById('authModalTitle').textContent = 'Sign In to Account';
    } else {
      this.tabRegisterBtn?.classList.add('active');
      this.tabSignInBtn?.classList.remove('active');
      this.registerForm?.classList.remove('hidden');
      this.signInForm?.classList.add('hidden');
      document.getElementById('authModalTitle').textContent = 'Register & Open Bank Account';
    }
  }

  async quickLoginDemo(personaKey) {
    this.closeAuthModal();
    await this.switchPersona(personaKey);
  }

  async handleSignInSubmit(e) {
    e.preventDefault();
    const email = document.getElementById('signInEmail').value.trim();
    const password = document.getElementById('signInPassword').value;

    const submitBtn = document.getElementById('signInSubmitBtn');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Signing In...</span>';

    try {
      this.showToast(`Authenticating with Auth Service (Port 8081)...`, 'INFO');
      const data = await window.api.login(email, password);
      this.updateAuthUI(data.user);
      await this.refreshUserData();
      this.startNotificationStream();
      this.closeAuthModal();
      this.showToast(`Welcome back, ${data.user.fullName}!`, 'SUCCESS');
      window.opsDashboard?.loadUsersDirectory();
    } catch (err) {
      this.showToast(`Login failed: ${err.message}`, 'ERROR');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>Sign In to Account</span>';
    }
  }

  async handleRegisterSubmit(e) {
    e.preventDefault();
    const fullName = document.getElementById('regFullName').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const phone = document.getElementById('regPhone').value.trim();
    const password = document.getElementById('regPassword').value;
    const transactionPin = document.getElementById('regPin').value.trim();

    const submitBtn = document.getElementById('registerSubmitBtn');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Registering with Microservices...</span>';

    try {
      this.showToast('Calling Auth Service /register & publishing USER_REGISTERED event...', 'INFO');
      const data = await window.api.register({
        fullName,
        email,
        phone,
        password,
        transactionPin
      });

      this.updateAuthUI(data.user);
      
      // Wait a moment for EventBus to auto-provision Checking and Savings accounts
      setTimeout(async () => {
        await this.refreshUserData();
        this.startNotificationStream();
        this.closeAuthModal();
        this.showToast(`Registration Successful! Checking & Savings accounts auto-provisioned!`, 'SUCCESS');
        window.opsDashboard?.loadUsersDirectory();
      }, 500);

    } catch (err) {
      this.showToast(`Registration failed: ${err.message}`, 'ERROR');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>Create Account & Register</span>';
    }
  }

  handleSignOut() {
    window.api.logout();
    if (this.notifEventSource) {
      this.notifEventSource.close();
      this.notifEventSource = null;
    }
    this.updateAuthUI(null);
    this.showToast('You have been signed out.', 'INFO');
    this.openAuthModal('signin');
  }

  async switchPersona(personaKey) {
    const credentials = {
      john: { email: 'john.doe@bank.com', password: 'Password123!' },
      sarah: { email: 'sarah.connor@bank.com', password: 'Password123!' },
      admin: { email: 'admin@bank.com', password: 'AdminSecret123!' }
    };

    const cred = credentials[personaKey] || credentials.john;

    try {
      this.showToast(`Switching persona to ${cred.email}...`, 'INFO');
      const loginData = await window.api.login(cred.email, cred.password);
      
      this.updateAuthUI(loginData.user);
      await this.refreshUserData();
      this.startNotificationStream();
      this.showToast(`Logged in as ${loginData.user.fullName}`, 'SUCCESS');
      window.opsDashboard?.loadUsersDirectory();
    } catch (err) {
      this.showToast(`Login failed: ${err.message}`, 'ERROR');
    }
  }

  async refreshUserData() {
    if (!window.api.currentUser) return;
    const userId = window.api.currentUser.id;

    try {
      // 1. Fetch Accounts
      this.accounts = await window.api.getAccounts(userId);
      this.renderAccounts();
      this.renderNetWorth();

      // 2. Fetch Transactions
      this.transactions = await window.api.getTransactions(userId);
      this.renderTransactions();

      // 3. Fetch Notifications
      const notifData = await window.api.getNotifications(userId);
      this.renderNotifications(notifData.notifications || []);
    } catch (err) {
      console.warn('Failed refreshing user data:', err.message);
    }
  }

  // Real-time Push Notifications via SSE
  startNotificationStream() {
    if (this.notifEventSource) this.notifEventSource.close();
    const userId = window.api.currentUser?.id;
    if (!userId) return;

    this.notifEventSource = new EventSource(`/api/notifications/stream/${userId}`);

    this.notifEventSource.onmessage = (event) => {
      try {
        const notif = JSON.parse(event.data);
        if (notif.title) {
          this.showToast(`${notif.title}: ${notif.message}`, notif.type || 'INFO');
          this.refreshUserData();
        }
      } catch (e) {
        // Heartbeat
      }
    };
  }

  renderNetWorth() {
    const total = this.accounts.reduce((sum, acc) => sum + (parseFloat(acc.balance) || 0), 0);
    if (this.isBalanceHidden) {
      this.totalNetWorthEl.textContent = '••••••';
    } else {
      this.totalNetWorthEl.textContent = total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
  }

  renderAccounts() {
    if (!this.accountsListEl) return;
    this.accountCountBadgeEl.textContent = `${this.accounts.length} ${this.accounts.length === 1 ? 'Account' : 'Accounts'}`;

    if (this.accounts.length === 0) {
      this.accountsListEl.innerHTML = '<div class="empty-state">No accounts opened yet.</div>';
      return;
    }

    this.accountsListEl.innerHTML = this.accounts.map(acc => {
      const isChecking = acc.type === 'CHECKING';
      const isFrozen = acc.status === 'FROZEN';
      const balanceStr = this.isBalanceHidden ? '••••••' : `$${Number(acc.balance).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

      return `
        <div class="account-item-card">
          <div>
            <div class="acc-type">
              <span>${isChecking ? '💳 Checking Account' : (acc.type === 'SAVINGS' ? '💎 High-Yield Savings' : '📈 Investment Account')}</span>
              ${isFrozen ? '<span class="status-badge FAILED_ROLLED_BACK">FROZEN</span>' : ''}
            </div>
            <div class="acc-num">Acct: ${acc.accountNumber} • ${acc.iban}</div>
          </div>
          <div class="acc-balance">
            <div class="val">${balanceStr}</div>
            <div class="cur">${acc.currency}</div>
          </div>
        </div>
      `;
    }).join('');

    // Setup active card
    const cardAcc = this.accounts.find(a => a.cards && a.cards.length > 0);
    if (cardAcc && cardAcc.cards[0]) {
      this.activeCard = cardAcc.cards[0];
      this.cardNumberDisplay.textContent = this.activeCard.cardNumber;
      this.cardHolderDisplay.textContent = this.activeCard.cardholderName;
      this.cardExpiryDisplay.textContent = this.activeCard.expiry;
      this.cardCvvDisplay.textContent = this.activeCard.cvv;
      this.cardLockToggle.checked = this.activeCard.status === 'FROZEN';
      this.cardOnlineToggle.checked = Boolean(this.activeCard.onlinePurchases);
      this.creditCardEl.classList.toggle('frozen', this.activeCard.status === 'FROZEN');
    }
  }

  renderTransactions() {
    if (!this.transactionsTableBodyEl) return;

    let filtered = this.transactions;
    if (this.currentFilter !== 'ALL') {
      filtered = filtered.filter(t => t.type === this.currentFilter);
    }

    if (filtered.length === 0) {
      this.transactionsTableBodyEl.innerHTML = '<tr><td colspan="5" class="text-dim text-center">No transactions found for filter.</td></tr>';
      return;
    }

    this.transactionsTableBodyEl.innerHTML = filtered.map(t => {
      const isDebit = t.fromAccount === this.accounts[0]?.accountNumber || t.type === 'TRANSFER' || t.type === 'PAYMENT';
      const isDeposit = t.type === 'DEPOSIT';
      const amountPrefix = isDeposit ? '+' : (isDebit ? '-' : '');
      const amountClass = isDeposit ? 'amount-positive' : 'amount-negative';

      const statusMap = {
        'COMPLETED': 'COMPLETED',
        'FAILED_ROLLED_BACK': 'FAILED_ROLLED_BACK',
        'BLOCKED_FRAUD': 'BLOCKED_FRAUD'
      };

      const dateStr = new Date(t.createdAt).toLocaleDateString() + ' ' + new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      return `
        <tr>
          <td>
            <div class="txn-title">${t.description || 'Fund Transfer'}</div>
            <div class="txn-subtitle">${t.fromAccount} ➔ ${t.toAccount}</div>
          </td>
          <td>
            <span class="ref-tag" onclick="window.app.inspectSaga('${t.referenceId}')">${t.referenceId}</span>
          </td>
          <td class="text-dim">${dateStr}</td>
          <td class="${amountClass}">
            ${amountPrefix}$${Number(t.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </td>
          <td>
            <span class="status-badge ${statusMap[t.status] || 'COMPLETED'}">
              ${t.status}
            </span>
          </td>
        </tr>
      `;
    }).join('');
  }

  renderNotifications(notifs) {
    this.notifications = notifs;
    const unreadCount = notifs.filter(n => !n.isRead).length;

    if (unreadCount > 0) {
      this.notifBadgeEl.textContent = unreadCount;
      this.notifBadgeEl.classList.remove('hidden');
    } else {
      this.notifBadgeEl.classList.add('hidden');
    }

    if (!this.notifListEl) return;

    if (notifs.length === 0) {
      this.notifListEl.innerHTML = '<div class="empty-state">No notifications.</div>';
      return;
    }

    this.notifListEl.innerHTML = notifs.slice(0, 15).map(n => {
      const timeStr = new Date(n.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `
        <div class="notif-item ${n.isRead ? '' : 'unread'} ${n.type || 'INFO'}">
          <div style="font-weight:700;">${n.title}</div>
          <div style="color:var(--text-muted); margin: 2px 0;">${n.message}</div>
          <div style="font-size:0.7rem; color:var(--text-dim);">${timeStr}</div>
        </div>
      `;
    }).join('');
  }

  async markAllNotificationsRead() {
    try {
      await window.api.markAllNotificationsRead();
      this.refreshUserData();
      this.showToast('All notifications marked as read', 'INFO');
    } catch (err) {
      console.warn('Failed to mark all read:', err);
    }
  }

  // --- Modal Openers ---
  openTransferModal() {
    if (!this.transferFromSelect) return;
    this.transferFromSelect.innerHTML = this.accounts.map(a => `
      <option value="${a.accountNumber}">${a.type} (${a.accountNumber}) — Balance: $${Number(a.balance).toLocaleString()}</option>
    `).join('');

    this.updateSourceBalanceHint();
    this.transferModal.classList.remove('hidden');
  }

  closeTransferModal() {
    this.transferModal?.classList.add('hidden');
    this.transferForm?.reset();
  }

  updateSourceBalanceHint() {
    const accNum = this.transferFromSelect?.value;
    const acc = this.accounts.find(a => a.accountNumber === accNum);
    if (acc && this.sourceBalanceHint) {
      this.sourceBalanceHint.textContent = `Available balance: $${Number(acc.balance).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    }
  }

  openDepositModal() {
    const targetSelect = document.getElementById('depositTargetAccount');
    if (targetSelect) {
      targetSelect.innerHTML = this.accounts.map(a => `
        <option value="${a.accountNumber}">${a.type} (${a.accountNumber})</option>
      `).join('');
    }
    this.depositModal?.classList.remove('hidden');
  }

  closeDepositModal() {
    this.depositModal?.classList.add('hidden');
  }

  // --- Form Handlers ---
  async handleTransferSubmit(e) {
    e.preventDefault();

    const fromAccount = this.transferFromSelect.value;
    const toAccount = this.transferToInput.value.trim();
    const amount = parseFloat(this.transferAmountInput.value);
    const description = document.getElementById('transferDescription').value.trim();
    const pin = this.transferPinInput.value;

    const confirmBtn = document.getElementById('confirmTransferBtn');
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<span>Verifying PIN & Saga...</span>';

    try {
      // 1. Verify Transaction PIN with Auth Microservice
      await window.api.verifyPin(pin);

      // 2. Trigger Transfer Saga Orchestration
      this.showToast('Executing Distributed Transfer Saga...', 'INFO');
      const result = await window.api.transferFunds({
        fromAccount,
        toAccount,
        amount,
        description: description || 'Bank Transfer'
      });

      this.closeTransferModal();
      this.showToast(`Transfer Succeeded! Ref: ${result.referenceId}`, 'SUCCESS');

      // Update Ops visualizer if active
      window.opsDashboard?.renderSagaSteps(result.referenceId, result.sagaSteps);
      await this.refreshUserData();
    } catch (err) {
      this.showToast(`Transfer Failed: ${err.message}`, 'ERROR');
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = '<span>Authorize Transfer</span>';
    }
  }

  async handleDepositSubmit(e) {
    e.preventDefault();
    const accountNumber = document.getElementById('depositTargetAccount').value;
    const amount = parseFloat(document.getElementById('depositAmount').value);
    const description = document.getElementById('depositSource').value;

    try {
      await window.api.depositFunds({ accountNumber, amount, description });
      this.closeDepositModal();
      this.showToast(`Deposited $${amount.toLocaleString()} into ${accountNumber}!`, 'SUCCESS');
      await this.refreshUserData();
    } catch (err) {
      this.showToast(`Deposit failed: ${err.message}`, 'ERROR');
    }
  }

  async handleNewAccountSubmit(e) {
    e.preventDefault();
    const type = document.getElementById('newAccountType').value;
    const deposit = parseFloat(document.getElementById('newAccountDeposit').value) || 0;

    try {
      const newAcc = await window.api.openAccount(type, deposit);
      this.newAccountModal.classList.add('hidden');
      this.showToast(`New ${type} Account opened! (${newAcc.accountNumber})`, 'SUCCESS');
      await this.refreshUserData();
    } catch (err) {
      this.showToast(`Failed to open account: ${err.message}`, 'ERROR');
    }
  }

  async inspectSaga(referenceId) {
    try {
      const details = await window.api.getSagaDetails(referenceId);
      const container = document.getElementById('sagaAuditModalContent');
      if (!container) return;

      const stepsHtml = (details.sagaSteps || []).map((s, idx) => `
        <div class="saga-step-row ${s.status}">
          <strong>${idx + 1}. ${s.step}</strong>: ${s.status}
          ${s.details?.error ? `<div class="text-danger" style="margin-top:4px;">${s.details.error}</div>` : ''}
          <div class="step-time">${new Date(s.timestamp || Date.now()).toLocaleTimeString()}</div>
        </div>
      `).join('');

      container.innerHTML = `
        <div style="margin-bottom:1rem; font-size:0.9rem;">
          <div>Reference ID: <code>${details.referenceId}</code></div>
          <div>Amount: <strong>$${Number(details.amount).toLocaleString()}</strong> (${details.fromAccount} ➔ ${details.toAccount})</div>
          <div>Final Status: <span class="status-badge ${details.status}">${details.status}</span></div>
        </div>
        <div class="saga-steps-stepper">${stepsHtml || '<div class="step-placeholder">No steps recorded for this transaction.</div>'}</div>
      `;

      this.sagaAuditModal.classList.remove('hidden');
    } catch (err) {
      this.showToast('Could not load saga details', 'ERROR');
    }
  }

  exportCsvStatement() {
    if (this.transactions.length === 0) {
      this.showToast('No transactions to export', 'WARNING');
      return;
    }

    const headers = ['ReferenceID', 'Date', 'Type', 'FromAccount', 'ToAccount', 'Amount', 'Currency', 'Status', 'Description'];
    const rows = this.transactions.map(t => [
      t.referenceId,
      t.createdAt,
      t.type,
      t.fromAccount,
      t.toAccount,
      t.amount,
      t.currency || 'USD',
      t.status,
      `"${(t.description || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `apex_bank_statement_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    this.showToast('Statement CSV downloaded successfully!', 'SUCCESS');
  }

  showToast(message, type = 'INFO') {
    if (!this.toastContainerEl) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <div class="toast-title">${type}</div>
      <div class="toast-body">${message}</div>
    `;

    this.toastContainerEl.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4500);
  }
}

window.app = new BankingApp();
