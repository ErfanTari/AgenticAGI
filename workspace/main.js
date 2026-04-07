import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let scene, camera, renderer, controls;
let particleSystem;

const numStars = 200000;
const galaxyRadius = 500;
const bulgeRadius = 50;
const diskThickness = 20;
const numArms = 4;
const armTightness = 0.5; // Adjust for tighter/looser spirals
const armSpread = 0.1; // How much particles spread out from the ideal spiral line
const bulgeRatio = 0.15; // Percentage of stars in the bulge

function init() {
    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000); // Black background for space

    // Camera
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
    camera.position.set(0, 200, 500); // Initial camera position
    camera.lookAt(0, 0, 0);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    // Controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; // Animate the damping
    controls.dampingFactor = 0.05;
    controls.screenSpacePanning = false;
    controls.minDistance = 10;
    controls.maxDistance = 1000;

    // Create Galaxy
    createGalaxy();

    // Handle window resize
    window.addEventListener('resize', onWindowResize, false);

    // Start animation loop
    animate();
}

function createGalaxy() {
    const positions = new Float32Array(numStars * 3);
    const colors = new Float32Array(numStars * 3);

    const colorBulge = new THREE.Color(0xFFDDAA); // Warm white/yellow for the bulge
    const colorArmStart = new THREE.Color(0xAAAAFF); // Bluish white for inner arms
    const colorArmEnd = new THREE.Color(0xFFFFFF); // Pure white for outer arms

    for (let i = 0; i < numStars; i++) {
        const i3 = i * 3;

        let x, y, z;
        let color = new THREE.Color();

        // Decide if star is in bulge or arms based on bulgeRatio
        if (Math.random() < bulgeRatio) {
            // Central Bulge
            const r = Math.random() * bulgeRadius;
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos((Math.random() * 2) - 1); // Spherical distribution

            x = r * Math.sin(phi) * Math.cos(theta);
            y = r * Math.sin(phi) * Math.sin(theta);
            z = r * Math.cos(phi) * 0.5; // Make bulge slightly flattened

            color.copy(colorBulge);
            color.multiplyScalar(0.8 + Math.random() * 0.4); // Vary brightness
        } else {
            // Spiral Arms
            const r = bulgeRadius + Math.random() * (galaxyRadius - bulgeRadius);
            const armIndex = Math.floor(Math.random() * numArms);
            const armAngleOffset = (armIndex / numArms) * Math.PI * 2;

            // Logarithmic spiral approximation
            const angle = r * armTightness + armAngleOffset;

            // Add randomness to spread particles around the arm
            const randomAngleOffset = (Math.random() - 0.5) * armSpread * Math.PI * 2;
            const finalAngle = angle + randomAngleOffset;

            x = r * Math.cos(finalAngle);
            y = r * Math.sin(finalAngle);
            // Z-position, thinner at edges
            z = (Math.random() - 0.5) * diskThickness * (1 - r / galaxyRadius);

            // Interpolate color based on distance from center for arms
            color.copy(colorArmStart).lerp(colorArmEnd, (r - bulgeRadius) / (galaxyRadius - bulgeRadius));
            color.multiplyScalar(0.7 + Math.random() * 0.6); // Vary brightness
        }

        positions[i3] = x;
        positions[i3 + 1]