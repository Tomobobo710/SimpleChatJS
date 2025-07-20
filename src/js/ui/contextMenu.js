// Custom Context Menu for Electron
class ElectronContextMenu {
    constructor() {
        this.menu = null;
        this.init();
    }

    init() {
        // Check if we're in Electron and have the API available
        if (typeof window !== 'undefined' && window.electronAPI) {
            window.electronAPI.onShowContextMenu((data) => {
                this.showMenu(data.x, data.y, data.items);
            });

            // Hide menu on clicks outside
            document.addEventListener('click', () => {
                this.hideMenu();
            });

            // Hide menu on scroll
            document.addEventListener('scroll', () => {
                this.hideMenu();
            }, true);

            // Hide menu on window resize
            window.addEventListener('resize', () => {
                this.hideMenu();
            });
        }
    }

    showMenu(x, y, items) {
        this.hideMenu(); // Hide any existing menu

        // Create menu element
        this.menu = document.createElement('div');
        this.menu.className = 'electron-context-menu';
        this.menu.style.left = x + 'px';
        this.menu.style.top = y + 'px';

        // Add menu items
        items.forEach(item => {
            if (item.action === 'separator') {
                const separator = document.createElement('div');
                separator.className = 'electron-context-menu-separator';
                this.menu.appendChild(separator);
            } else {
                const menuItem = document.createElement('div');
                menuItem.className = 'electron-context-menu-item';
                menuItem.textContent = item.label;
                
                menuItem.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.hideMenu();
                    if (window.electronAPI) {
                        window.electronAPI.executeContextAction(item.action);
                    }
                });

                this.menu.appendChild(menuItem);
            }
        });

        // Add to DOM
        document.body.appendChild(this.menu);
        this.menu.style.display = 'block';

        // Adjust position if menu goes off-screen
        const rect = this.menu.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        if (rect.right > viewportWidth) {
            this.menu.style.left = (x - rect.width) + 'px';
        }
        if (rect.bottom > viewportHeight) {
            this.menu.style.top = (y - rect.height) + 'px';
        }
    }

    hideMenu() {
        if (this.menu) {
            this.menu.remove();
            this.menu = null;
        }
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        new ElectronContextMenu();
    });
} else {
    new ElectronContextMenu();
}
