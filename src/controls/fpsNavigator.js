import * as THREE from 'three';
import gsap from 'gsap';
import { groundHeightAt, isInPond } from '../scene/garden.js';

// A literal average adult eye height (1.65) reads as crouched in a garden
// scaled the way this one is -- the gulmohar alone is 11.5m tall, the grass
// brushes past at knee height, and looking slightly further down at the
// world reads more like a child's-eye view than a comfortable walk.
const EYE_HEIGHT = 1.78;
const WALK_SPEED = 4.2;
const SPRINT_SPEED = 7.5;
const ACCEL = 32.0;
const FRICTION = 14.0;
const MAX_RADIUS = 37.5;
// How close the camera itself may get to a trunk's fitted radius -- an eye,
// not a point, and bark this close would already be clipping the near plane.
const PLAYER_RADIUS = 0.35;
const JUMP_IMPULSE = 6.2;
const GRAVITY = 18.0;

// Fraction of the joystick's own radius, from centre, ignored before any
// movement input is read. Thumb tremor near rest otherwise reads as a slow,
// persistent creep -- especially noticeable now that WALK_SPEED starts
// applying from the very first pixel of travel.
const JOYSTICK_DEADZONE = 0.14;

export class FPSNavigator {
    constructor(camera, domElement, options = {}) {
        this.camera = camera;
        this.domElement = domElement;
        this.onModeChange = options.onModeChange || null;

        this.enabled = false;
        this.position = new THREE.Vector3(14, groundHeightAt(14, 14) + EYE_HEIGHT, 14);
        this.targetY = this.position.y;
        this.currentGroundY = groundHeightAt(14, 14);
        this.heightOffset = 0;
        this.baseFov = this.camera.fov || 50;

        // Dynamic pinch zoom & third-person / aerial elevation
        this.zoomDistance = 0;
        this.targetZoomDistance = 0;
        this.activeTouches = new Map();
        this.isPinching = false;
        this.initialPinchDist = 0;
        this.initialZoomDist = 0;

        this.velocity = new THREE.Vector3();
        this.yaw = -Math.PI * 0.75;
        this.pitch = -0.08;

        this.targetYaw = this.yaw;
        this.targetPitch = this.pitch;

        // Head bob
        this.bobCycle = 0;
        this.bobOffset = new THREE.Vector3();
        this.idleCycle = 0;

        // Input state
        this.keys = {
            forward: false,
            backward: false,
            left: false,
            right: false,
            sprint: false,
            jump: false
        };

        // Vertical jump physics
        this.jumpVelocity = 0;
        this.jumpOffset = 0;
        this.isGrounded = true;

        // Pointer / Touch tracking
        this.isPointerDown = false;
        this.activePointerId = null;
        this.lastPointerX = 0;
        this.lastPointerY = 0;
        this.pointerLocked = false;

        // Virtual touch joystick state
        this.touchMove = { x: 0, y: 0 };
        this.joystickPointerId = null;
        this.lookPointerId = null;
        this.joystickOrigin = { x: 0, y: 0 };

        this._setupKeyboard();
        this._setupPointer();
        this._createTouchUI();
    }

    _setupKeyboard() {
        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            let consumed = true;
            switch (e.code) {
                case 'KeyW':
                case 'ArrowUp':
                    this.keys.forward = true;
                    break;
                case 'KeyS':
                case 'ArrowDown':
                    this.keys.backward = true;
                    break;
                case 'KeyA':
                case 'ArrowLeft':
                    this.keys.left = true;
                    break;
                case 'KeyD':
                case 'ArrowRight':
                    this.keys.right = true;
                    break;
                case 'ShiftLeft':
                case 'ShiftRight':
                    this.keys.sprint = true;
                    break;
                case 'Space':
                    this.keys.jump = true;
                    if (this.isGrounded) {
                        this.jumpVelocity = JUMP_IMPULSE;
                        this.isGrounded = false;
                    }
                    e.preventDefault();
                    break;
                default:
                    consumed = false;
            }

            if (consumed && !this.enabled && (this.keys.forward || this.keys.backward || this.keys.left || this.keys.right || this.keys.jump)) {
                if (this.onModeChange) this.onModeChange(true);
            }
        });

        window.addEventListener('keyup', (e) => {
            switch (e.code) {
                case 'KeyW':
                case 'ArrowUp':
                    this.keys.forward = false;
                    break;
                case 'KeyS':
                case 'ArrowDown':
                    this.keys.backward = false;
                    break;
                case 'KeyA':
                case 'ArrowLeft':
                    this.keys.left = false;
                    break;
                case 'KeyD':
                case 'ArrowRight':
                    this.keys.right = false;
                    break;
                case 'ShiftLeft':
                case 'ShiftRight':
                    this.keys.sprint = false;
                    break;
                case 'Space':
                    this.keys.jump = false;
                    break;
            }
        });
    }

    _setupPointer() {
        this.domElement.addEventListener('pointerdown', (e) => {
            if (!this.enabled) return;
            // Ignore if touching on UI buttons, dock, sprint or jump buttons
            if (e.target.closest('#dock') || e.target.closest('.fps-sprint-btn') || e.target.closest('.fps-jump-btn') || e.target.closest('header') || e.target.closest('#hover-label')) return;

            if (e.pointerType === 'touch') {
                this.activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });

                if (this.activeTouches.size >= 2) {
                    // Two fingers on screen: start pinch zoom
                    this.isPinching = true;
                    const pts = Array.from(this.activeTouches.values());
                    this.initialPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
                    this.initialZoomDist = this.targetZoomDistance;

                    if (this.joystickPointerId !== null) {
                        this.joystickPointerId = null;
                        this.touchMove.x = 0;
                        this.touchMove.y = 0;
                        this._hideJoystick();
                    }
                    this.lookPointerId = null;
                    return;
                }

                if (this.isPinching) return;

                // Generous thumb zone for left-hand walk joystick
                const isLeftZone = e.clientX < window.innerWidth * 0.50 || (e.clientX < window.innerWidth * 0.60 && e.clientY > window.innerHeight * 0.40);
                if (isLeftZone && this.joystickPointerId === null) {
                    this.joystickPointerId = e.pointerId;
                    this.joystickOrigin = { x: e.clientX, y: e.clientY };
                    this._showJoystick(e.clientX, e.clientY);
                } else if (this.lookPointerId === null) {
                    this.lookPointerId = e.pointerId;
                    this.lastPointerX = e.clientX;
                    this.lastPointerY = e.clientY;
                }
            } else {
                this.isPointerDown = true;
                this.lastPointerX = e.clientX;
                this.lastPointerY = e.clientY;
            }
        });

        window.addEventListener('pointermove', (e) => {
            if (!this.enabled) return;

            if (document.pointerLockElement === this.domElement) {
                const sensitivity = 0.0022;
                this.targetYaw -= e.movementX * sensitivity;
                this.targetPitch -= e.movementY * sensitivity;
                this.targetPitch = Math.max(-Math.PI * 0.44, Math.min(Math.PI * 0.44, this.targetPitch));
                return;
            }

            if (e.pointerType === 'touch') {
                if (this.activeTouches.has(e.pointerId)) {
                    this.activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
                }

                if (this.activeTouches.size >= 2) {
                    // Two-finger pinch gesture: zoom in or out from current angle
                    const pts = Array.from(this.activeTouches.values());
                    const currentDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
                    if (this.initialPinchDist > 5) {
                        // Pinching together increases zoomDistance (pulls camera back/up)
                        // Spreading fingers decreases zoomDistance (moves camera toward FPS)
                        const delta = (this.initialPinchDist - currentDist) * 0.045;
                        this.targetZoomDistance = Math.max(0, Math.min(26.0, this.initialZoomDist + delta));
                    }
                    return;
                }

                if (this.isPinching) return;

                if (e.pointerId === this.joystickPointerId) {
                    const dx = e.clientX - this.joystickOrigin.x;
                    const dy = e.clientY - this.joystickOrigin.y;
                    const maxDist = this._joystickRadius();
                    const dist = Math.hypot(dx, dy);
                    const clampedDist = Math.min(maxDist, dist);
                    const angle = Math.atan2(dy, dx);

                    // The thumb visual tracks the raw finger position (still
                    // feels attached to the touch), but the movement OUTPUT
                    // goes through a deadzone and an eased curve: a thumb
                    // resting near centre is a few pixels of unavoidable
                    // tremor, not intent, and was read as a slow persistent
                    // drift; a raw-linear response also made the first
                    // millimetre of travel already near-full speed, which is
                    // what read as jerky/imprecise starts and stops on a
                    // touchscreen.
                    let mag = clampedDist / maxDist;
                    mag = mag < JOYSTICK_DEADZONE ? 0 : (mag - JOYSTICK_DEADZONE) / (1 - JOYSTICK_DEADZONE);
                    mag = mag * mag * (3 - 2 * mag); // smoothstep

                    this.touchMove.x = Math.cos(angle) * mag;
                    this.touchMove.y = -Math.sin(angle) * mag; // inverted Y for forward
                    this._updateJoystickThumb(Math.cos(angle) * clampedDist, Math.sin(angle) * clampedDist);
                } else if (e.pointerId === this.lookPointerId) {
                    const dx = e.clientX - this.lastPointerX;
                    const dy = e.clientY - this.lastPointerY;
                    this.lastPointerX = e.clientX;
                    this.lastPointerY = e.clientY;

                    // Responsive look rotation for mobile touchscreens
                    const sensitivity = 0.0052;
                    this.targetYaw -= dx * sensitivity;
                    this.targetPitch -= dy * sensitivity;
                    this.targetPitch = Math.max(-Math.PI * 0.44, Math.min(Math.PI * 0.44, this.targetPitch));
                }
            } else if (this.isPointerDown) {
                const dx = e.clientX - this.lastPointerX;
                const dy = e.clientY - this.lastPointerY;
                this.lastPointerX = e.clientX;
                this.lastPointerY = e.clientY;

                const sensitivity = 0.0030;
                this.targetYaw -= dx * sensitivity;
                this.targetPitch -= dy * sensitivity;
                this.targetPitch = Math.max(-Math.PI * 0.44, Math.min(Math.PI * 0.44, this.targetPitch));
            }
        });

        const onPointerUp = (e) => {
            if (e.pointerType === 'touch') {
                this.activeTouches.delete(e.pointerId);
                if (this.activeTouches.size < 2) {
                    this.isPinching = false;
                    this.initialPinchDist = 0;
                }
                if (e.pointerId === this.joystickPointerId) {
                    this.joystickPointerId = null;
                    this.touchMove.x = 0;
                    this.touchMove.y = 0;
                    this._hideJoystick();
                }
                if (e.pointerId === this.lookPointerId) {
                    this.lookPointerId = null;
                }
            } else {
                this.isPointerDown = false;
            }
        };

        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);

        // Desktop wheel / trackpad pinch zoom
        this.domElement.addEventListener('wheel', (e) => {
            if (!this.enabled) return;
            e.preventDefault();
            const scale = e.ctrlKey ? 0.035 : 0.012;
            const delta = e.deltaY * scale;
            this.targetZoomDistance = Math.max(0, Math.min(26.0, this.targetZoomDistance + delta));
        }, { passive: false });

        document.addEventListener('pointerlockchange', () => {
            this.pointerLocked = (document.pointerLockElement === this.domElement);
        });
    }

    _createTouchUI() {
        const zone = document.createElement('div');
        zone.className = 'fps-touch-zone';
        zone.id = 'fps-touch-controls';
        zone.style.display = 'none';

        zone.innerHTML = `
            <div class="fps-joystick-base" id="fps-joystick-base">
                <div class="fps-joystick-thumb" id="fps-joystick-thumb"></div>
            </div>
            <button class="fps-jump-btn glass-btn" id="fps-jump-btn" aria-label="Jump">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 19V5M5 12l7-7 7 7"/>
                </svg>
            </button>
            <button class="fps-sprint-btn glass-btn" id="fps-sprint-toggle" aria-label="Toggle Sprint">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                </svg>
            </button>
            <div class="fps-walk-hint" id="fps-walk-hint">
                <span class="fps-hint-desktop">WASD to Walk · Space to Jump · Shift to Sprint · Drag to Look</span>
                <span class="fps-hint-mobile">Touch &amp; Drag to Walk/Look · Tap Jump/Sprint</span>
            </div>
        `;

        document.body.appendChild(zone);

        this.touchZone = zone;
        this.joystickBase = zone.querySelector('#fps-joystick-base');
        this.joystickThumb = zone.querySelector('#fps-joystick-thumb');
        this.sprintBtn = zone.querySelector('#fps-sprint-toggle');
        this.jumpBtn = zone.querySelector('#fps-jump-btn');

        // pointerdown, not click: it fires the instant a finger lands rather
        // than waiting for the up-event + the browser's tap/scroll
        // disambiguation, which is the same latency jumpBtn below already
        // avoids.
        this.sprintBtn.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.keys.sprint = !this.keys.sprint;
            this.sprintBtn.classList.toggle('active', this.keys.sprint);
        });

        if (this.jumpBtn) {
            this.jumpBtn.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (this.isGrounded) {
                    this.jumpVelocity = JUMP_IMPULSE;
                    this.isGrounded = false;
                }
            });
        }

        // Hide hint after 5 seconds
        setTimeout(() => {
            const hint = document.getElementById('fps-walk-hint');
            if (hint) hint.classList.add('fps-hint-fade');
        }, 5000);
    }

    /**
     * The joystick's own radius in CSS px, matching `.fps-joystick-base`'s
     * `clamp(84px, 22vw, 120px)` diameter exactly (same formula, halved) --
     * one source of truth for how far a thumb can travel, so the visual ring
     * and the drag distance that reaches full speed never disagree. Scales
     * with viewport width so a small phone and a tablet each get a stick
     * that occupies roughly the same fraction of a thumb's comfortable
     * reach, rather than a fixed pixel size that reads as cramped on one and
     * tiny-in-the-corner on the other.
     */
    _joystickRadius() {
        return Math.max(84, Math.min(120, window.innerWidth * 0.22)) / 2;
    }

    _resetJoystickRestPosition() {
        if (!this.joystickBase) return;
        const isTouch = ('ontouchstart' in window || navigator.maxTouchPoints > 0);
        if (isTouch) {
            const rx = Math.max(64, Math.min(90, window.innerWidth * 0.20));
            const ry = window.innerHeight - Math.max(90, Math.min(130, window.innerHeight * 0.18));
            this.joystickBase.style.left = `${rx}px`;
            this.joystickBase.style.top = `${ry}px`;
            this.joystickBase.style.opacity = '0.45';
            this.joystickBase.style.transform = 'translate(-50%, -50%) scale(0.95)';
        } else {
            this.joystickBase.style.opacity = '0';
            this.joystickBase.style.transform = 'translate(-50%, -50%) scale(0.85)';
        }
        if (this.joystickThumb) {
            this.joystickThumb.style.transform = 'translate(-50%, -50%)';
        }
    }

    _showJoystick(x, y) {
        if (!this.joystickBase) return;
        this.joystickBase.style.left = `${x}px`;
        this.joystickBase.style.top = `${y}px`;
        this.joystickBase.style.opacity = '1';
        this.joystickBase.style.transform = 'translate(-50%, -50%) scale(1)';
        this.joystickThumb.style.transform = 'translate(-50%, -50%)';
    }

    _updateJoystickThumb(dx, dy) {
        if (!this.joystickThumb) return;
        this.joystickThumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    }

    _hideJoystick() {
        this._resetJoystickRestPosition();
    }

    enable(startPosition = null, startLookTarget = null) {
        this.enabled = true;
        this.baseFov = this.camera.fov || 50;
        this.zoomDistance = 0;
        this.targetZoomDistance = 0;
        this.activeTouches.clear();
        this.isPinching = false;

        if (startPosition) {
            this.position.x = startPosition.x;
            this.position.z = startPosition.z;
            this.currentGroundY = groundHeightAt(this.position.x, this.position.z);
            this.targetY = this.currentGroundY + EYE_HEIGHT;
            this.position.y = this.targetY;
            this.heightOffset = 0;
        } else {
            // Adopt current camera horizontal location clamped to garden boundary
            let camX = this.camera.position.x;
            let camZ = this.camera.position.z;
            const dist = Math.hypot(camX, camZ);
            if (dist > MAX_RADIUS - 1.0) {
                const s = (MAX_RADIUS - 1.0) / dist;
                camX *= s;
                camZ *= s;
            }
            this.position.x = camX;
            this.position.z = camZ;
            this.currentGroundY = groundHeightAt(this.position.x, this.position.z);
            this.targetY = this.currentGroundY + EYE_HEIGHT;
            // Smoothly glide height down to eye level if camera was overhead
            this.heightOffset = this.camera.position.y - this.targetY;
            this.position.y = this.camera.position.y;
        }

        if (startLookTarget) {
            const dx = startLookTarget.x - this.position.x;
            const dz = startLookTarget.z - this.position.z;
            const dy = startLookTarget.y - this.position.y;
            this.yaw = Math.atan2(-dx, -dz);
            this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
            this.targetYaw = this.yaw;
            this.targetPitch = this.pitch;
        } else {
            // Adopt active camera forward direction with 0 jump or rotation pop
            const forward = new THREE.Vector3();
            this.camera.getWorldDirection(forward);
            this.yaw = Math.atan2(-forward.x, -forward.z);
            this.pitch = Math.asin(Math.max(-0.95, Math.min(0.95, forward.y)));
            this.targetYaw = this.yaw;
            this.targetPitch = this.pitch;
        }

        this.velocity.set(0, 0, 0);
        if (this.touchZone) {
            this.touchZone.style.display = 'block';
            this._resetJoystickRestPosition();
            const hint = document.getElementById('fps-walk-hint');
            if (hint) {
                hint.classList.remove('fps-hint-fade');
                setTimeout(() => hint.classList.add('fps-hint-fade'), 4500);
            }
        }
    }

    enableFromCamera() {
        this.enable();
    }

    /** @param {Array<{x:number,z:number,radius:number}>} circles */
    setColliders(circles) {
        this._colliders = circles;
    }

    disable() {
        this.enabled = false;
        this.keys.forward = false;
        this.keys.backward = false;
        this.keys.left = false;
        this.keys.right = false;
        this.keys.sprint = false;
        this.touchMove.x = 0;
        this.touchMove.y = 0;
        this.heightOffset = 0;
        this.zoomDistance = 0;
        this.targetZoomDistance = 0;
        this.activeTouches.clear();
        this.isPinching = false;
        if (document.pointerLockElement === this.domElement) {
            document.exitPointerLock();
        }
        if (this.touchZone) {
            this.touchZone.style.display = 'none';
        }
    }

    fastTravelTo(targetX, targetZ, lookTarget = null, duration = 1.2) {
        gsap.killTweensOf(this.position);
        gsap.killTweensOf(this.camera.position);

        this.heightOffset = 0;
        this.zoomDistance = 0;
        this.targetZoomDistance = 0;
        const groundY = groundHeightAt(targetX, targetZ);
        const eyeY = groundY + EYE_HEIGHT;
        this.velocity.set(0, 0, 0);

        if (lookTarget) {
            const dx = lookTarget.x - targetX;
            const dz = lookTarget.z - targetZ;
            const dy = (lookTarget.y !== undefined ? lookTarget.y : groundY + 1.2) - eyeY;
            this.targetYaw = Math.atan2(-dx, -dz);
            this.targetPitch = Math.max(-Math.PI * 0.35, Math.min(Math.PI * 0.35, Math.atan2(dy, Math.hypot(dx, dz))));
        }

        gsap.to(this.position, {
            x: targetX,
            y: eyeY,
            z: targetZ,
            duration: duration,
            ease: 'power2.inOut',
            onUpdate: () => {
                this.currentGroundY = groundHeightAt(this.position.x, this.position.z);
                this.targetY = this.currentGroundY + EYE_HEIGHT;
                this.camera.position.set(this.position.x, this.position.y, this.position.z);
            },
            onComplete: () => {
                this.currentGroundY = groundHeightAt(this.position.x, this.position.z);
                this.position.y = this.currentGroundY + EYE_HEIGHT;
                this.targetY = this.position.y;
                this.velocity.set(0, 0, 0);
            }
        });
    }

    requestPointerLock() {
        if (this.enabled && this.domElement.requestPointerLock) {
            this.domElement.requestPointerLock();
        }
    }

    update(dt) {
        if (!this.enabled) return;

        // Smooth camera rotation lerp
        this.yaw += (this.targetYaw - this.yaw) * Math.min(1.0, 18.0 * dt);
        this.pitch += (this.targetPitch - this.pitch) * Math.min(1.0, 18.0 * dt);

        // Movement direction relative to camera yaw
        const forwardX = -Math.sin(this.yaw);
        const forwardZ = -Math.cos(this.yaw);
        const rightX = Math.cos(this.yaw);
        const rightZ = -Math.sin(this.yaw);

        let inputX = 0;
        let inputZ = 0;

        if (this.keys.forward) inputZ += 1;
        if (this.keys.backward) inputZ -= 1;
        if (this.keys.right) inputX += 1;
        if (this.keys.left) inputX -= 1;

        // Virtual joystick input. The pointermove handler above already
        // applies JOYSTICK_DEADZONE and zeroes touchMove exactly below it, so
        // this only needs to guard against float noise, not re-deadzone --
        // a second, coarser cutoff here used to eat the first several percent
        // of the eased curve's range as well, making the stick feel like it
        // had a dead centre wider than the visible ring.
        if (Math.abs(this.touchMove.x) > 1e-4 || Math.abs(this.touchMove.y) > 1e-4) {
            inputX = this.touchMove.x;
            inputZ = this.touchMove.y;
        }

        const inputLen = Math.hypot(inputX, inputZ);
        if (inputLen > 1.0) {
            inputX /= inputLen;
            inputZ /= inputLen;
        }

        const maxSpeed = this.keys.sprint ? SPRINT_SPEED : WALK_SPEED;
        const targetVelX = (forwardX * inputZ + rightX * inputX) * maxSpeed;
        const targetVelZ = (forwardZ * inputZ + rightZ * inputX) * maxSpeed;

        // Accelerate or decelerate with friction
        const accelRate = inputLen > 0.01 ? ACCEL : FRICTION;
        this.velocity.x += (targetVelX - this.velocity.x) * Math.min(1.0, accelRate * dt);
        this.velocity.z += (targetVelZ - this.velocity.z) * Math.min(1.0, accelRate * dt);

        // Integrate horizontal position, remembering where we came from so
        // the pond can put us back: the basin is not a circle, so it cannot
        // be one of the collider circles below, and a walker who is already
        // in the water has nowhere sensible to be pushed to.
        const prevX = this.position.x, prevZ = this.position.z;
        this.position.x += this.velocity.x * dt;
        this.position.z += this.velocity.z * dt;

        // The waterline, tested against the baked terrain, so this follows
        // the shore's real shape. Each axis is refused separately, so walking
        // into the bank at an angle slides you along it instead of stopping
        // you dead -- the same feel as the trunk circles.
        if (isInPond(this.position.x, this.position.z)) {
            if (!isInPond(prevX, this.position.z)) {
                this.position.x = prevX;
                this.velocity.x = 0;
            } else if (!isInPond(this.position.x, prevZ)) {
                this.position.z = prevZ;
                this.velocity.z = 0;
            } else {
                this.position.x = prevX;
                this.position.z = prevZ;
                this.velocity.x = 0;
                this.velocity.z = 0;
            }
        }

        // Soft circular boundary limit
        const distFromCenter = Math.hypot(this.position.x, this.position.z);
        if (distFromCenter > MAX_RADIUS) {
            const scale = MAX_RADIUS / distFromCenter;
            this.position.x *= scale;
            this.position.z *= scale;
            this.velocity.x *= 0.5;
            this.velocity.z *= 0.5;
        }

        // Trunk collision: pushed back out to the trunk's own edge along the
        // line from its centre, not simply halted, so walking into a trunk
        // at an angle slides you around it rather than stopping you dead
        // against invisible geometry. Cheap -- a handful of circles, not a
        // mesh collider -- and reuses the same fitted trunk radii place mode
        // aims rope/surface mounts against, so a trunk you can lean a
        // painting on is also one you cannot walk through.
        if (this._colliders) {
            for (const c of this._colliders) {
                const dx = this.position.x - c.x, dz = this.position.z - c.z;
                const minDist = c.radius + PLAYER_RADIUS;
                const d = Math.hypot(dx, dz);
                if (d > 1e-4 && d < minDist) {
                    const push = minDist / d;
                    this.position.x = c.x + dx * push;
                    this.position.z = c.z + dz * push;
                }
            }
        }

        // Sample terrain height smoothly
        const gY = groundHeightAt(this.position.x, this.position.z);
        this.currentGroundY += (gY - this.currentGroundY) * Math.min(1.0, 12.0 * dt);
        this.targetY = this.currentGroundY + EYE_HEIGHT;

        // Smooth zoom distance easing
        this.zoomDistance += (this.targetZoomDistance - this.zoomDistance) * Math.min(1.0, 10.0 * dt);

        // Press of arrow / movement slowly helps travel back to fps
        const isMoving = (this.keys.forward || this.keys.backward || this.keys.left || this.keys.right || 
                         Math.hypot(this.touchMove.x, this.touchMove.y) > 0.05);

        if (isMoving && !this.isPinching) {
            // Slowly travel back to fps while user walks with arrows/WASD/joystick
            if (this.targetZoomDistance > 0.001) {
                const returnStep = (this.targetZoomDistance * 0.38 + 1.25) * dt;
                this.targetZoomDistance = Math.max(0, this.targetZoomDistance - returnStep);
            }
            if (Math.abs(this.heightOffset) > 0.01) {
                const hStep = (Math.abs(this.heightOffset) * 0.38 + 0.95) * dt;
                if (this.heightOffset > 0) {
                    this.heightOffset = Math.max(0, this.heightOffset - hStep);
                } else {
                    this.heightOffset = Math.min(0, this.heightOffset + hStep);
                }
            } else {
                this.heightOffset = 0;
            }
        }

        // Vertical jump & gravity integration
        if (!this.isGrounded || this.jumpOffset > 0) {
            this.jumpVelocity -= GRAVITY * dt;
            this.jumpOffset += this.jumpVelocity * dt;

            if (this.jumpOffset <= 0) {
                this.jumpOffset = 0;
                this.jumpVelocity = 0;
                this.isGrounded = true;
            } else {
                this.isGrounded = false;
            }
        } else if (this.keys.jump && this.isGrounded) {
            this.jumpVelocity = JUMP_IMPULSE;
            this.isGrounded = false;
        }

        // Apply ground height & elevation offset
        if (Math.abs(this.heightOffset) > 0.01) {
            this.position.y = this.targetY + this.heightOffset;
        } else {
            this.heightOffset = 0;
            this.position.y += (this.targetY - this.position.y) * Math.min(1.0, 14.0 * dt);
        }

        // Head bobbing simulation (quenched while airborne)
        const speed = Math.hypot(this.velocity.x, this.velocity.z);
        if (speed > 0.3 && this.zoomDistance < 1.0 && this.isGrounded) {
            const strideFreq = this.keys.sprint ? 14.0 : 10.0;
            this.bobCycle += strideFreq * dt;
            const bobAmount = this.keys.sprint ? 0.048 : 0.028;
            this.bobOffset.y = Math.sin(this.bobCycle) * bobAmount;
            this.bobOffset.x = Math.cos(this.bobCycle * 0.5) * (bobAmount * 0.6);
        } else {
            // Idle breathing motion
            this.idleCycle += 1.8 * dt;
            this.bobOffset.y = this.isGrounded ? Math.sin(this.idleCycle) * 0.005 : 0;
            this.bobOffset.x = 0;
            this.bobCycle = 0;
        }

        // Apply position to camera with jump leap
        this.camera.position.set(
            this.position.x + this.bobOffset.x * forwardZ,
            this.position.y + this.jumpOffset + this.bobOffset.y,
            this.position.z + this.bobOffset.x * (-forwardX)
        );

        // Compute look target vector from yaw and pitch
        const cosPitch = Math.cos(this.pitch);
        const lookDir = new THREE.Vector3(
            -Math.sin(this.yaw) * cosPitch,
            Math.sin(this.pitch),
            -Math.cos(this.yaw) * cosPitch
        );

        // If zoomed out, pull camera back along look direction and slightly elevate
        if (this.zoomDistance > 0.001) {
            this.camera.position.x -= lookDir.x * this.zoomDistance;
            this.camera.position.y -= (lookDir.y * this.zoomDistance * 0.35) - (this.zoomDistance * 0.28);
            this.camera.position.z -= lookDir.z * this.zoomDistance;

            // Ensure camera never clips underground
            const minCamY = groundHeightAt(this.camera.position.x, this.camera.position.z) + 0.85;
            if (this.camera.position.y < minCamY) {
                this.camera.position.y = minCamY;
            }
        }

        const lookAtPoint = this.camera.position.clone().add(lookDir);
        this.camera.lookAt(lookAtPoint);

        // Subtle dynamic FOV expansion during sprint based on active camera baseFov
        const baseFov = this.baseFov || 50;
        const targetFov = this.keys.sprint && speed > 2.0 ? baseFov + 4.0 : baseFov;
        if (Math.abs(this.camera.fov - targetFov) > 0.1) {
            this.camera.fov += (targetFov - this.camera.fov) * Math.min(1.0, 8.0 * dt);
            this.camera.updateProjectionMatrix();
        }
    }
}
