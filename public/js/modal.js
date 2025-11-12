// /js/modal.js
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('confirm-modal');
  const cancelBtn = document.getElementById('modal-cancel');
  const confirmBtn = document.getElementById('clear');          
  const triggerBtns = document.querySelectorAll('#warning-modal, .warning-modal'); 
  const drawerTrigger = document.querySelector('.drawer-cta');   

  function openModal() {
    if (!modal) return;
    modal.classList.remove('hide');
    document.body.style.overflow = 'hidden';
    cancelBtn?.focus();
  }

  function closeModal() {
    if (!modal) return;
    modal.classList.add('hide');
    document.body.style.overflow = '';
  }

  // Attach to all triggers
  triggerBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openModal();
    });
  });

  drawerTrigger?.addEventListener('click', (e) => { 
    e.preventDefault(); 
    openModal(); 
  });

  cancelBtn?.addEventListener('click', closeModal);
  modal?.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  confirmBtn?.addEventListener('click', () => { location.reload(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hide')) closeModal();
  });
});
