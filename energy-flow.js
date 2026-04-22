(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const INKSCAPE_LABEL = 'http://www.inkscape.org/namespaces/inkscape';
  const FLOW_DEFAULTS = new Set(['from-grid']);
  const FORWARD_FLOW_LABELS = new Set([
    'battery-only-to-grid',
    'battery-to-grid',
    'solar-only-to-grid',
    'solar-to-grid',
    'from-battery',
    'battery-to-home',
    'grid-to-home',
    'from-solar',
    'solar-to-home',
  ]);
  const SUPPLY_LABELS = new Set(['from-grid', 'from-battery', 'from-solar']);
  const HEAD_TRAVEL_DURATION = 1.98;
  const SUPPLY_SPINOFF_SEMAPHORE = 1.5;
  const DEFAULT_LENGTH = 0.28;
  const SNAKE_SEGMENTS = 7;
  const SNAKE_INSTANCES = 8;
  const flowStates = new Map();

  const svgObject = document.getElementById('energySvg');
  const tree = document.getElementById('tree');
  const status = document.getElementById('status');
  const showAllButton = document.getElementById('showAll');
  const hideAllButton = document.getElementById('hideAll');
  const restartFlowButton = document.getElementById('restartFlow');
  let animationStartedAt = performance.now();
  let animationFrame = 0;
  let isInitializing = false;
  let pathUnitsPerSecond = 1;
  let snakeReferenceLength = 1;
  let groupTiming = {
    demandDurations: [],
    hasDemand: false,
    hasSupply: false,
    supplyHeadEnd: HEAD_TRAVEL_DURATION,
  };

  const getLabel = (node) =>
    node.getAttributeNS(INKSCAPE_LABEL, 'label') ||
    node.getAttribute('inkscape:label') ||
    node.id ||
    'unlabelled';

  const setDisplay = (node, visible) => {
    node.style.display = visible ? 'inline' : 'none';
  };

  const isVisibleByStyle = (node) => {
    const style = node.getAttribute('style') || '';
    return !/display\s*:\s*none/i.test(style);
  };

  const isEffectivelyVisible = (node, boundary) => {
    let current = node;
    while (current && current.nodeType === 1 && current !== boundary.parentElement) {
      if (!isVisibleByStyle(current)) return false;
      if (current === boundary) return true;
      current = current.parentElement;
    }
    return isVisibleByStyle(node);
  };

  const revealAncestors = (node, boundary) => {
    let current = node.parentElement;
    while (current && current.nodeType === 1 && current !== boundary.parentElement) {
      if (current !== boundary) setDisplay(current, true);
      if (current === boundary) return;
      current = current.parentElement;
    }
  };

  const isInNoGrid = (node) => {
    let current = node;
    while (current && current.nodeType === 1) {
      if (getLabel(current).toLowerCase() === 'no-grid') return true;
      current = current.parentElement;
    }
    return false;
  };

  const isIdlePath = (label) => label.toLowerCase().startsWith('idle-');

  const isAnimatedFlowPath = (path) => {
    const label = getLabel(path).toLowerCase();
    if (isIdlePath(label) || label === 'no-grid') return false;
    if (label.startsWith('cross-')) return false;
    return !isInNoGrid(path);
  };

  const buildReversedPathData = (sourcePath, length) => {
    const steps = 72;
    const points = [];

    for (let index = 0; index <= steps; index += 1) {
      const distance = length - (length * index) / steps;
      const point = sourcePath.getPointAtLength(distance);
      points.push(`${index === 0 ? 'M' : 'L'} ${point.x.toFixed(3)} ${point.y.toFixed(3)}`);
    }

    return points.join(' ');
  };

  const createPulse = (svg, sourcePath) => {
    const label = getLabel(sourcePath);
    const length = Math.max(sourcePath.getTotalLength(), 1);
    const pulseGroup = svg.ownerDocument.createElementNS(NS, 'g');
    const isForward = FORWARD_FLOW_LABELS.has(label);
    const instances = [];

    pulseGroup.setAttribute('aria-hidden', 'true');
    pulseGroup.dataset.sourcePathId = sourcePath.id;
    pulseGroup.classList.add('flow-pulse-path');
    pulseGroup.style.display = 'inline';
    pulseGroup.style.filter = 'none';
    pulseGroup.style.opacity = '1';
    pulseGroup.style.pointerEvents = 'none';

    for (let instanceIndex = 0; instanceIndex < SNAKE_INSTANCES; instanceIndex += 1) {
      const instanceGroup = svg.ownerDocument.createElementNS(NS, 'g');
      const segments = [];

      instanceGroup.style.display = 'none';
      pulseGroup.appendChild(instanceGroup);

      for (let index = 0; index < SNAKE_SEGMENTS; index += 1) {
        const segment = sourcePath.cloneNode(false);
        const fade = index / (SNAKE_SEGMENTS - 1);

        segment.setAttribute('d', isForward ? sourcePath.getAttribute('d') : buildReversedPathData(sourcePath, length));
        segment.removeAttribute('id');
        segment.removeAttribute('inkscape:label');
        segment.style.display = 'inline';
        segment.style.filter = 'none';
        segment.style.opacity = `${0.12 + fade * 0.88}`;
        segment.style.pointerEvents = 'none';
        instanceGroup.appendChild(segment);
        segments.push({ element: segment, fadeIndex: index });
      }

      instances.push({ group: instanceGroup, segments });
    }

    return {
      element: pulseGroup,
      endOffset: -length,
      instances,
      length,
    };
  };

  const getTimingGroup = (label) => (SUPPLY_LABELS.has(label) ? 'supply' : 'demand');

  const restartPulseAnimations = () => {
    animationStartedAt = performance.now();
  };

  const hideStateInstances = (state) => {
    state.instances.forEach((instance) => {
      instance.group.style.display = 'none';
    });
  };

  const renderInstance = (state, instance, elapsed) => {
    const pulseLength = Math.max(snakeReferenceLength * state.snakeLength, 1);
    const segmentLength = Math.max(pulseLength / SNAKE_SEGMENTS * 1.45, 1);
    const segmentGap = state.length + pulseLength + segmentLength;
    const travelDistance = state.length + pulseLength + segmentLength;
    const clearDuration = travelDistance / pathUnitsPerSecond;

    if (elapsed < 0 || elapsed > clearDuration) {
      instance.group.style.display = 'none';
      return;
    }

    instance.group.style.display = 'inline';

    instance.segments.forEach((segment) => {
      const tailIndex = SNAKE_SEGMENTS - 1 - segment.fadeIndex;
      const lag = (tailIndex / (SNAKE_SEGMENTS - 1)) * Math.max(pulseLength - segmentLength, 0);
      const startOffset = segmentLength + lag;
      const offset = startOffset - elapsed * pathUnitsPerSecond;

      segment.element.style.strokeDasharray = `${segmentLength} ${segmentGap}`;
      segment.element.style.strokeDashoffset = `${offset}`;
    });
  };

  const buildGroupStartTimes = (elapsedSeconds) => {
    const supplyStarts = [];
    const demandStarts = [];
    const demandCompletions = [];
    let hasHeldSupplySpinoff = false;
    let semaphoreUntil = 0;

    const addSupplyStart = (startTime) => {
      if (!groupTiming.hasSupply || startTime > elapsedSeconds) return;

      supplyStarts.push(startTime);
      semaphoreUntil = startTime + SUPPLY_SPINOFF_SEMAPHORE;

      if (groupTiming.hasDemand) {
        const demandStart = startTime + groupTiming.supplyHeadEnd;
        demandStarts.push(demandStart);
        groupTiming.demandDurations.forEach((duration) => {
          demandCompletions.push(demandStart + duration);
        });
      }
    };

    if (groupTiming.hasSupply) {
      addSupplyStart(0);
    } else if (groupTiming.hasDemand) {
      demandStarts.push(0);
    }

    while (demandCompletions.length) {
      demandCompletions.sort((a, b) => a - b);
      const completionTime = demandCompletions.shift();

      if (completionTime > elapsedSeconds) break;
      if (completionTime >= semaphoreUntil) {
        hasHeldSupplySpinoff = false;
        addSupplyStart(completionTime);
      } else if (!hasHeldSupplySpinoff) {
        hasHeldSupplySpinoff = true;
        demandCompletions.push(semaphoreUntil);
      }
    }

    return {
      demand: demandStarts
        .filter((startTime) => startTime <= elapsedSeconds)
        .sort((a, b) => b - a)
        .slice(0, SNAKE_INSTANCES),
      supply: supplyStarts
        .sort((a, b) => b - a)
        .slice(0, SNAKE_INSTANCES),
    };
  };

  const renderFlow = () => {
    const elapsedSeconds = (performance.now() - animationStartedAt) / 1000;
    const groupStartTimes = buildGroupStartTimes(elapsedSeconds);

    flowStates.forEach((state) => {
      if (!state.pulse || !state.visible || state.cycleDuration <= 0) {
        if (state.pulse) hideStateInstances(state);
        return;
      }

      let instanceIndex = 0;
      const startTimes = state.timingGroup === 'supply'
        ? groupStartTimes.supply
        : groupStartTimes.demand;

      startTimes.forEach((startTime) => {
        const instance = state.instances[instanceIndex];
        if (instance) renderInstance(state, instance, elapsedSeconds - startTime);
        instanceIndex += 1;
      });

      for (; instanceIndex < state.instances.length; instanceIndex += 1) {
        state.instances[instanceIndex].group.style.display = 'none';
      }
    });

    animationFrame = requestAnimationFrame(renderFlow);
  };

  const travelDurationFor = (state) => state.length / pathUnitsPerSecond;

  const updatePulseTiming = () => {
    const animatedStates = Array.from(flowStates.values()).filter((state) => state.pulse);
    const visibleAnimatedStates = animatedStates.filter((state) => state.visible);
    const visibleSupply = visibleAnimatedStates.filter((state) => state.timingGroup === 'supply');
    const visibleDemand = visibleAnimatedStates.filter((state) => state.timingGroup === 'demand');
    const supplyHeadEnd = visibleSupply.length ? Math.max(...visibleSupply.map(travelDurationFor)) : 0;
    const cycleDuration = supplyHeadEnd || HEAD_TRAVEL_DURATION;

    groupTiming = {
      demandDurations: visibleDemand.map(travelDurationFor),
      hasDemand: Boolean(visibleDemand.length),
      hasSupply: Boolean(visibleSupply.length),
      supplyHeadEnd: supplyHeadEnd || HEAD_TRAVEL_DURATION,
    };

    animatedStates.forEach((state) => {
      state.cycleDuration = cycleDuration;
      state.travelDuration = travelDurationFor(state);
    });
  };

  const getIdleLabelForFlow = (label) => {
    if (label === 'from-grid' || label.endsWith('-to-grid')) return 'idle-grid';
    if (label === 'from-battery' || label.endsWith('-to-battery')) return 'idle-battery';
    if (label.endsWith('-to-home')) return 'idle-home';
    if (label === 'from-solar') return 'idle-solar';
    return null;
  };

  const applyIdleBaseStyle = (path, idlePaths) => {
    const label = getLabel(path);
    const idlePath = idlePaths.get(getIdleLabelForFlow(label));

    path.dataset.flowLabel = label;
    path.classList.add('flow-base-path');
    path.style.filter = 'none';

    if (!idlePath) return;

    const display = path.style.display || 'none';
    path.setAttribute('style', idlePath.getAttribute('style') || '');
    path.style.display = display;
    path.style.filter = 'none';
  };

  const applyFlowVisibility = (state, visible) => {
    state.visible = visible;
    if (visible) revealAncestors(state.base, state.boundary);
    setDisplay(state.base, visible);
    if (state.pulse) setDisplay(state.pulse, visible);
    if (state.checkbox) state.checkbox.checked = visible;
    if (!isInitializing) updatePulseTiming();
  };

  const createTreeItem = (groupName, state) => {
    const item = document.createElement('li');
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    const text = document.createElement('span');

    checkbox.type = 'checkbox';
    checkbox.checked = state.visible;
    checkbox.addEventListener('change', () => applyFlowVisibility(state, checkbox.checked));
    state.checkbox = checkbox;

    text.textContent = state.pulse ? state.label : `${state.label} (static)`;
    label.className = 'curve-toggle';
    label.append(checkbox, text);
    item.append(label);

    return item;
  };

  const controlGroupForState = (state) => {
    if (!state.pulse) return 'Idle';
    return state.timingGroup === 'supply' ? 'Supply' : 'Demand';
  };

  const buildTree = (states) => {
    tree.replaceChildren();

    const byGroup = new Map();
    states.forEach((state) => {
      const group = controlGroupForState(state);
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group).push(state);
    });

    ['Supply', 'Demand', 'Idle'].forEach((groupName) => {
      const groupStates = byGroup.get(groupName) || [];
      const section = document.createElement('li');
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      const list = document.createElement('ul');

      summary.textContent = groupName;
      groupStates
        .sort((a, b) => a.label.localeCompare(b.label))
        .forEach((state) => list.append(createTreeItem(groupName, state)));

      details.append(summary, list);
      section.append(details);
      tree.append(section);
    });
  };

  const nearestFlowGroup = (path) => {
    let current = path.parentElement;
    while (current && current.nodeType === 1) {
      const label = getLabel(current);
      if (label.endsWith('-select-one') || label.includes('-select-')) return label;
      current = current.parentElement;
    }
    return 'curves';
  };

  const initialize = () => {
    isInitializing = true;
    const doc = svgObject.contentDocument;
    const svg = doc && doc.querySelector('svg');
    const flowLayer = svg && Array.from(svg.querySelectorAll('g')).find((group) => getLabel(group) === 'energy-flow-select-many');

    if (!svg || !flowLayer) {
      status.textContent = 'SVG flow layer was not found.';
      isInitializing = false;
      return;
    }

    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.display = 'block';

    flowStates.clear();
    doc.getElementById('energy-flow-animation-layer')?.remove();

    const animationLayer = doc.createElementNS(NS, 'g');
    animationLayer.id = 'energy-flow-animation-layer';
    animationLayer.setAttribute('aria-hidden', 'true');
    flowLayer.appendChild(animationLayer);

    const allPaths = Array.from(flowLayer.querySelectorAll('path'));
    const flowPaths = allPaths.filter(isAnimatedFlowPath);
    const idlePaths = new Map(
      allPaths
        .filter((path) => isIdlePath(getLabel(path)))
        .map((path) => [getLabel(path), path])
    );

    const states = flowPaths.map((path) => {
      const label = getLabel(path);
      const pulse = createPulse(svg, path);
      const visible = FLOW_DEFAULTS.has(label);
      applyIdleBaseStyle(path, idlePaths);
      animationLayer.appendChild(pulse.element);

      const state = {
        base: path,
        boundary: flowLayer,
        endOffset: pulse.endOffset,
        group: nearestFlowGroup(path),
        label,
        length: pulse.length,
        instances: pulse.instances,
        pulse: pulse.element,
        snakeLength: DEFAULT_LENGTH,
        timingGroup: getTimingGroup(label),
        visible,
      };

      flowStates.set(label, state);
      applyFlowVisibility(state, visible);
      return state;
    });

    const defaultTimingPath = flowStates.get('from-grid') || states.find((state) => state.pulse);
    pathUnitsPerSecond = defaultTimingPath
      ? defaultTimingPath.length / HEAD_TRAVEL_DURATION
      : 1;
    snakeReferenceLength = defaultTimingPath ? defaultTimingPath.length : 1;

    allPaths
      .filter((path) => !isAnimatedFlowPath(path))
      .forEach((path) => {
        const label = getLabel(path);
        const state = {
          base: path,
          boundary: flowLayer,
          group: isInNoGrid(path) ? 'no-grid' : nearestFlowGroup(path),
          label,
          pulse: null,
          visible: isEffectivelyVisible(path, flowLayer),
        };

        flowStates.set(label, state);
        applyFlowVisibility(state, state.visible);
        states.push(state);
      });

    buildTree(states);
    isInitializing = false;
    updatePulseTiming();
    restartPulseAnimations();
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(renderFlow);
    status.textContent = `${flowPaths.length} animated flow curves, ${states.length - flowPaths.length} static curves.`;
  };

  showAllButton.addEventListener('click', () => {
    flowStates.forEach((state) => applyFlowVisibility(state, true));
  });

  hideAllButton.addEventListener('click', () => {
    flowStates.forEach((state) => applyFlowVisibility(state, false));
  });

  restartFlowButton.addEventListener('click', restartPulseAnimations);

  svgObject.addEventListener('load', initialize);
})();
