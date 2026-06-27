const STATUS_EL = document.getElementById('controller-status');

export class GamepadController {
  constructor() {
    this.state = {
      leftX: 0, leftY: 0,
      rightX: 0, rightY: 0,
      lt: 0, rt: 0,
      buttons: new Array(17).fill(false),
      // Button map (standard gamepad):
      // 0=A  1=B  2=X  3=Y
      // 4=LB 5=RB 6=LT 7=RT
      // 8=Select 9=Start
      // 10=L3  11=R3
      // 12=Up 13=Down 14=Left 15=Right
    };
    this._prevButtons = new Array(17).fill(false);
    this._connected = false;

    window.addEventListener('gamepadconnected', (e) => {
      this._connected = true;
      STATUS_EL.textContent = `🎮 Gamepad: ${e.gamepad.id.slice(0, 30)}`;
      STATUS_EL.className = 'connected';
    });
    window.addEventListener('gamepaddisconnected', () => {
      this._connected = false;
      STATUS_EL.textContent = '⬛ Gamepad: desconectado';
      STATUS_EL.className = 'disconnected';
    });
  }

  update() {
    const gamepads = navigator.getGamepads();
    let gp = null;
    for (const g of gamepads) {
      if (g && g.connected) { gp = g; break; }
    }
    if (!gp) return;

    const dead = 0.12; // deadzone

    this.state.leftX  = applyDeadzone(gp.axes[0], dead);
    this.state.leftY  = applyDeadzone(gp.axes[1], dead);
    this.state.rightX = applyDeadzone(gp.axes[2], dead);
    this.state.rightY = applyDeadzone(gp.axes[3], dead);

    // Triggers: axes 4+5 on some browsers, buttons 6+7 on others
    this.state.lt = gp.buttons[6]?.value ?? (gp.axes[4] ? (gp.axes[4] + 1) / 2 : 0);
    this.state.rt = gp.buttons[7]?.value ?? (gp.axes[5] ? (gp.axes[5] + 1) / 2 : 0);

    this._prevButtons = [...this.state.buttons];
    this.state.buttons = gp.buttons.map(b => b?.pressed ?? false);
  }

  // True only on the frame the button was pressed
  justPressed(index) {
    return this.state.buttons[index] && !this._prevButtons[index];
  }
}

function applyDeadzone(val, dead) {
  if (Math.abs(val) < dead) return 0;
  return (val - Math.sign(val) * dead) / (1 - dead);
}
