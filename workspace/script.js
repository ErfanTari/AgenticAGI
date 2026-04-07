import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

let scene, camera, renderer, controls, composer;
let galaxyParticles = [];

// Galaxy parameters
const GALAXY_RADIUS = 1000; // Overall radius of the galaxy disk
const GALAXY_THICKNESS = 50; // Thickness of the galaxy disk

// Number of particles for each