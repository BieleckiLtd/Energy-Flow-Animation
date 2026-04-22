(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const INKSCAPE_LABEL = 'http://www.inkscape.org/namespaces/inkscape';
  const FLOW_DEFAULTS = new Set([
    'from-battery',
    'from-solar',
    'battery-to-home',
    'solar-only-to-grid',
  ]);
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
  const DEMAND_CREATION_DELAY = 0.15; // compensate size of the inverter
  const DEFAULT_LENGTH = 0.28; 
  const SNAKE_SEGMENTS = 7;
  const BACKGROUND_FADE_MS = 160;
  const flowStates = new Map();

  const svgObject = document.getElementById('energySvg');
  const svgFrame = document.querySelector('.svg-frame');
  const fullscreenToggle = document.getElementById('fullscreenToggle');
  const tree = document.getElementById('tree');
  const backgroundButtons = document.getElementById('backgroundButtons');
  let animationStartedAt = performance.now();
  let animationFrame = 0;
  let backgroundTransitionTimeout = 0;
  let isInitializing = false;
  let pathUnitsPerSecond = 1;
  let snakeReferenceLength = 1;
  let groupTiming = {
    demandVisibleDuration: 0,
    hasDemand: false,
    hasSupply: false,
    supplyHeadEnd: HEAD_TRAVEL_DURATION,
    supplyVisibleDuration: 0,
  };

  const getLabel = (node) =>
    node.getAttributeNS(INKSCAPE_LABEL, 'label') ||
    node.getAttribute('inkscape:label') ||
    node.id ||
    'unlabelled';

  const findLayer = (svg, label) =>
    Array.from(svg.querySelectorAll('g')).find((group) => getLabel(group) === label);

  const updateFullscreenToggle = () => {
    if (!fullscreenToggle || !svgFrame) return;

    const isFullscreen = document.fullscreenElement === svgFrame;
    fullscreenToggle.setAttribute('aria-label', isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
    fullscreenToggle.setAttribute('title', isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
    fullscreenToggle.classList.toggle('is-fullscreen', isFullscreen);
  };

  const setupFullscreenToggle = () => {
    if (!fullscreenToggle || !svgFrame || !svgFrame.requestFullscreen) {
      if (fullscreenToggle) fullscreenToggle.hidden = true;
      return;
    }

    fullscreenToggle.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement === svgFrame) {
          await document.exitFullscreen();
        } else {
          await svgFrame.requestFullscreen();
        }
      } catch (error) {
        console.warn('Fullscreen toggle failed.', error);
      }
    });

    document.addEventListener('fullscreenchange', updateFullscreenToggle);
    updateFullscreenToggle();
  };

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

  const isCrossPath = (label) => label.toLowerCase().startsWith('cross-');

  const isAnimatedFlowPath = (path) => {
    const label = getLabel(path).toLowerCase();
    if (isIdlePath(label) || label === 'no-grid') return false;
    if (isCrossPath(label)) return false;
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

  const labelColorForBackground = (label) =>
    label.trim().toLowerCase().startsWith('dark') ? '#ffffff' : '#000000';

  const canPaint = (element, property, defaultForText = false) => {
    const inlineValue = element.style[property];
    const attributeValue = element.getAttribute(property);
    const paintValue = inlineValue || attributeValue;

    if (paintValue) return paintValue !== 'none';
    return defaultForText;
  };

  const applyLabelColor = (labelsLayer, color) => {
    if (!labelsLayer) return;

    Array.from(labelsLayer.querySelectorAll('*')).forEach((element) => {
      const tagName = element.tagName.toLowerCase();
      const isText = tagName === 'text' || tagName === 'tspan';

      element.style.transition = 'fill 160ms ease, stroke 160ms ease';
      if (canPaint(element, 'fill', isText)) element.style.fill = color;
      if (canPaint(element, 'stroke')) element.style.stroke = color;
    });
  };

  const updateBackgroundButtons = (backgrounds, selectedLabel) => {
    backgrounds.forEach((background) => {
      if (!background.button) return;
      const active = background.label === selectedLabel;

      background.button.classList.toggle('is-active', active);
      background.button.setAttribute('aria-pressed', String(active));
    });
  };

  const backgroundButtonLabel = (label) =>
    label.replace(/^(dark|light)-/i, '');

  const setBackgroundOpacity = (background, opacity, animated = true) => {
    background.element.style.transition = animated ? `opacity ${BACKGROUND_FADE_MS}ms ease` : 'none';
    background.element.style.opacity = String(opacity);

    if (!animated) {
      background.element.getBoundingClientRect();
      background.element.style.transition = `opacity ${BACKGROUND_FADE_MS}ms ease`;
    }
  };

  const applyBackground = (backgrounds, labelsLayer, selectedLabel, immediate = false) => {
    const nextBackground = backgrounds.find((background) => background.label === selectedLabel);
    const currentBackground = backgrounds.find((background) => background.selected);

    if (!nextBackground) return;

    if (backgroundTransitionTimeout) {
      clearTimeout(backgroundTransitionTimeout);
      backgroundTransitionTimeout = 0;
    }

    if (immediate || !currentBackground || currentBackground === nextBackground) {
      backgrounds.forEach((background) => {
        background.selected = background === nextBackground;
        setBackgroundOpacity(background, background.selected ? 1 : 0, !immediate);
      });
    } else if (currentBackground.index > nextBackground.index) {
      backgrounds.forEach((background) => {
        if (background !== currentBackground && background !== nextBackground) {
          background.selected = false;
          setBackgroundOpacity(background, 0, false);
        }
      });
      setBackgroundOpacity(nextBackground, 1, false);
      setBackgroundOpacity(currentBackground, 0, true);
      currentBackground.selected = false;
      nextBackground.selected = true;
    } else {
      backgrounds.forEach((background) => {
        if (background !== currentBackground && background !== nextBackground) {
          background.selected = false;
          setBackgroundOpacity(background, 0, false);
        }
      });
      setBackgroundOpacity(currentBackground, 1, false);
      setBackgroundOpacity(nextBackground, 1, true);
      currentBackground.selected = false;
      nextBackground.selected = true;
      backgroundTransitionTimeout = setTimeout(() => {
        backgroundTransitionTimeout = 0;
        if (!nextBackground.selected) return;
        setBackgroundOpacity(currentBackground, 0, false);
      }, BACKGROUND_FADE_MS);
    }

    updateBackgroundButtons(backgrounds, selectedLabel);
    applyLabelColor(labelsLayer, labelColorForBackground(selectedLabel));
  };

  const setupBackgroundControls = (svg) => {
    const bgLayer = findLayer(svg, 'bg');
    const labelsLayer = findLayer(svg, 'labels');
    const backgrounds = bgLayer
      ? Array.from(bgLayer.children)
          .filter((element) => element.nodeType === 1)
          .map((element) => ({
            element,
            label: getLabel(element),
            visible: isVisibleByStyle(element),
          }))
      : [];

    if (!backgroundButtons || !backgrounds.length) {
      if (backgroundButtons) backgroundButtons.replaceChildren();
      return 0;
    }

    const selectedBackground = backgrounds.find((background) => background.visible) || backgrounds[0];

    backgrounds.forEach((background, index) => {
      background.index = index;
      background.selected = background === selectedBackground;
      background.element.style.display = 'inline';
      background.element.style.opacity = background === selectedBackground ? '1' : '0';
      background.element.style.pointerEvents = 'none';
      background.element.style.transition = `opacity ${BACKGROUND_FADE_MS}ms ease`;
    });

    backgroundButtons.replaceChildren(
      ...backgrounds.map((background) => {
        const button = document.createElement('button');

        button.type = 'button';
        button.textContent = backgroundButtonLabel(background.label);
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => {
          applyBackground(backgrounds, labelsLayer, background.label);
        });
        background.button = button;

        return button;
      })
    );

    applyBackground(backgrounds, labelsLayer, selectedBackground.label, true);
    return backgrounds.length;
  };

  const matrixToTransform = (matrix) =>
    `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`;

  const getTransformIntoLayer = (sourcePath, targetLayer) => {
    const sourceMatrix = sourcePath.getCTM?.();
    const layerMatrix = targetLayer.getCTM?.();

    if (!sourceMatrix || !layerMatrix) return null;
    return layerMatrix.inverse().multiply(sourceMatrix);
  };

  const createPulse = (svg, sourcePath, targetLayer) => {
    const label = getLabel(sourcePath);
    const length = Math.max(sourcePath.getTotalLength(), 1);
    const pulseGroup = svg.ownerDocument.createElementNS(NS, 'g');
    const isForward = FORWARD_FLOW_LABELS.has(label);
    const segmentTemplate = sourcePath.cloneNode(false);
    const sourceTransform = getTransformIntoLayer(sourcePath, targetLayer);

    segmentTemplate.setAttribute('d', isForward ? sourcePath.getAttribute('d') : buildReversedPathData(sourcePath, length));
    segmentTemplate.removeAttribute('id');
    segmentTemplate.removeAttribute('inkscape:label');
    segmentTemplate.removeAttribute('transform');

    const createInstance = () => {
      const instanceGroup = svg.ownerDocument.createElementNS(NS, 'g');
      const segments = [];

      instanceGroup.style.display = 'none';
      pulseGroup.appendChild(instanceGroup);

      for (let index = 0; index < SNAKE_SEGMENTS; index += 1) {
        const segment = segmentTemplate.cloneNode(false);
        const isHead = index === SNAKE_SEGMENTS - 1;
        const fade = index / Math.max(SNAKE_SEGMENTS - 2, 1);

        segment.style.display = 'inline';
        segment.style.filter = 'none';
        segment.style.opacity = isHead ? '1' : `${0.12 + fade * 0.5}`;
        segment.style.pointerEvents = 'none';
        segment.style.strokeOpacity = '1';
        instanceGroup.appendChild(segment);
        segments.push({ element: segment, fadeIndex: index });
      }

      return { group: instanceGroup, segments };
    };
    const instances = [];

    pulseGroup.setAttribute('aria-hidden', 'true');
    pulseGroup.dataset.sourcePathId = sourcePath.id;
    pulseGroup.classList.add('flow-pulse-path');
    pulseGroup.style.display = 'inline';
    pulseGroup.style.filter = 'none';
    pulseGroup.style.opacity = '1';
    pulseGroup.style.pointerEvents = 'none';
    if (sourceTransform) pulseGroup.setAttribute('transform', matrixToTransform(sourceTransform));

    return {
      createInstance,
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

  const ensureInstance = (state, instanceIndex) => {
    while (state.instances.length <= instanceIndex) {
      state.instances.push(state.createInstance());
    }

    return state.instances[instanceIndex];
  };

  const clearDurationFor = (state) => {
    const pulseLength = Math.max(snakeReferenceLength * state.snakeLength, 1);
    const segmentLength = Math.max(pulseLength / SNAKE_SEGMENTS * 1.45, 1);
    return (state.length + pulseLength + segmentLength) / pathUnitsPerSecond;
  };

  const renderInstance = (state, instance, elapsed) => {
    const pulseLength = Math.max(snakeReferenceLength * state.snakeLength, 1);
    const segmentLength = Math.max(pulseLength / SNAKE_SEGMENTS * 1.45, 1);
    const segmentGap = state.length + pulseLength + segmentLength;
    const clearDuration = clearDurationFor(state);

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
    const supplyWaveStarts = [];
    const demandStarts = [];

    const addSupplyStart = (startTime) => {
      if (!groupTiming.hasSupply || startTime > elapsedSeconds) return;

      supplyWaveStarts.push(startTime);
      const supplyArrivalTime = startTime + groupTiming.supplyHeadEnd;

      if (groupTiming.hasDemand) {
        demandStarts.push(supplyArrivalTime + DEMAND_CREATION_DELAY);
      }
    };

    if (groupTiming.hasSupply) {
      const supplyInterval = Math.max(groupTiming.supplyHeadEnd, SUPPLY_SPINOFF_SEMAPHORE);
      const lookbackDuration = Math.max(
        groupTiming.supplyVisibleDuration,
        groupTiming.supplyHeadEnd + DEMAND_CREATION_DELAY + groupTiming.demandVisibleDuration
      );
      const firstVisibleWaveIndex = Math.max(0, Math.floor((elapsedSeconds - lookbackDuration) / supplyInterval));

      for (
        let startTime = firstVisibleWaveIndex * supplyInterval;
        startTime <= elapsedSeconds;
        startTime += supplyInterval
      ) {
        addSupplyStart(startTime);
      }
    } else if (groupTiming.hasDemand) {
      demandStarts.push(DEMAND_CREATION_DELAY);
    }

    return {
      demand: demandStarts
        .filter((startTime) => startTime <= elapsedSeconds)
        .filter((startTime) => startTime >= elapsedSeconds - groupTiming.demandVisibleDuration)
        .sort((a, b) => b - a),
      supply: supplyWaveStarts
        .filter((startTime) => startTime <= elapsedSeconds)
        .filter((startTime) => startTime >= elapsedSeconds - groupTiming.supplyVisibleDuration)
        .sort((a, b) => b - a),
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
      const startOffset = state.timingGroup === 'supply'
        ? Math.max(groupTiming.supplyHeadEnd - state.travelDuration, 0)
        : 0;

      startTimes.forEach((startTime) => {
        const instanceElapsed = elapsedSeconds - startTime - startOffset;
        if (instanceElapsed < 0) return;

        const instance = ensureInstance(state, instanceIndex);
        renderInstance(state, instance, instanceElapsed);
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
    const supplyVisibleDuration = visibleSupply.length
      ? Math.max(...visibleSupply.map((state) => Math.max(supplyHeadEnd - travelDurationFor(state), 0) + clearDurationFor(state)))
      : 0;
    const demandVisibleDuration = visibleDemand.length
      ? Math.max(...visibleDemand.map(clearDurationFor))
      : 0;
    const cycleDuration = supplyHeadEnd || HEAD_TRAVEL_DURATION;

    groupTiming = {
      demandVisibleDuration,
      hasDemand: Boolean(visibleDemand.length),
      hasSupply: Boolean(visibleSupply.length),
      supplyHeadEnd: supplyHeadEnd || HEAD_TRAVEL_DURATION,
      supplyVisibleDuration,
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

  const batteryDirectionForState = (state) => {
    if (!state.pulse) return null;
    if (
      state.label === 'from-battery' ||
      state.label.startsWith('battery-to-') ||
      state.label.startsWith('battery-only-to-')
    ) return 'fromBattery';
    if (state.label.endsWith('-to-battery')) return 'toBattery';
    return null;
  };

  const gridDirectionForState = (state) => {
    if (!state.pulse) return null;
    if (state.label === 'from-grid') return 'fromGrid';
    if (state.label.startsWith('grid-to-')) return 'fromGrid';
    if (state.label.endsWith('-to-grid')) return 'toGrid';
    return null;
  };

  const clearOppositeDirectionalFlows = (state, directionForState, directionPairs) => {
    const direction = directionForState(state);

    if (!direction) return;

    const oppositeDirection = directionPairs[direction];
    flowStates.forEach((otherState) => {
      if (otherState !== state && otherState.visible && directionForState(otherState) === oppositeDirection) {
        applyFlowVisibilityWithGridExportCoupling(otherState, false);
      }
    });
  };

  const clearDirectionalConflicts = (state) => {
    clearOppositeDirectionalFlows(state, batteryDirectionForState, {
      fromBattery: 'toBattery',
      toBattery: 'fromBattery',
    });
    clearOppositeDirectionalFlows(state, gridDirectionForState, {
      fromGrid: 'toGrid',
      toGrid: 'fromGrid',
    });
  };

  const sourceLabelForOutputState = (state) => {
    if (state.label.startsWith('battery-to-') || state.label.startsWith('battery-only-to-')) return 'from-battery';
    if (state.label.startsWith('grid-to-')) return 'from-grid';
    if (state.label.startsWith('solar-to-') || state.label.startsWith('solar-only-to-')) return 'from-solar';
    return null;
  };

  const applySourceForOutput = (state) => {
    const sourceLabel = sourceLabelForOutputState(state);

    if (!sourceLabel) return;

    const sourceState = flowStates.get(sourceLabel);
    if (!sourceState) return;

    clearDirectionalConflicts(sourceState);
    applyFlowVisibility(sourceState, true);
  };

  const isSharedGridExportState = (state) =>
    state.label === 'solar-to-grid' || state.label === 'battery-to-grid';

  const isOnlyGridExportState = (state) =>
    state.label.endsWith('-only-to-grid');

  const sharedGridExportStates = () =>
    ['solar-to-grid', 'battery-to-grid']
      .map((label) => flowStates.get(label))
      .filter(Boolean);

  const applyFlowVisibilityWithGridExportCoupling = (state, visible) => {
    if (isSharedGridExportState(state)) {
      sharedGridExportStates().forEach((sharedState) => applyFlowVisibility(sharedState, visible));
      return;
    }

    applyFlowVisibility(state, visible);
  };

  const isGridUnavailableState = (state) =>
    state.label === 'no-grid' || state.label.startsWith('cross-');

  const isGridAvailableState = (state) =>
    state.label === 'from-grid' ||
    state.label === 'idle-grid' ||
    state.label.startsWith('grid-to-') ||
    state.label.endsWith('-to-grid');

  const gridUnavailableStates = () =>
    Array.from(flowStates.values()).filter(isGridUnavailableState);

  const applyGridUnavailableVisibility = (visible) => {
    gridUnavailableStates().forEach((gridUnavailableState) => {
      applyFlowVisibility(gridUnavailableState, visible);
    });
  };

  const clearGridAvailableStates = () => {
    flowStates.forEach((otherState) => {
      if (isGridAvailableState(otherState)) applyFlowVisibilityWithGridExportCoupling(otherState, false);
    });
  };

  const applyGridUnavailableSelection = (state, visible) => {
    if (isGridUnavailableState(state)) {
      applyGridUnavailableVisibility(visible);
      if (visible) clearGridAvailableStates();
      return true;
    }

    if (visible && isGridAvailableState(state)) {
      applyGridUnavailableVisibility(false);
    }

    return false;
  };

  const applyGridExportSelection = (state, visible) => {
    if (isSharedGridExportState(state)) {
      sharedGridExportStates().forEach((sharedState) => {
        if (visible) clearDirectionalConflicts(sharedState);
        applyFlowVisibility(sharedState, visible);
        if (visible) applySourceForOutput(sharedState);
      });

      if (visible) {
        flowStates.forEach((otherState) => {
          if (isOnlyGridExportState(otherState)) applyFlowVisibility(otherState, false);
        });
      }

      return true;
    }

    if (visible && isOnlyGridExportState(state)) {
      flowStates.forEach((otherState) => {
        if (otherState !== state && (isOnlyGridExportState(otherState) || isSharedGridExportState(otherState))) {
          applyFlowVisibility(otherState, false);
        }
      });
      return false;
    }

    return false;
  };

  const applyFlowSelection = (state, visible) => {
    if (applyGridUnavailableSelection(state, visible)) return;
    if (applyGridExportSelection(state, visible)) return;

    if (visible) {
      clearDirectionalConflicts(state);
      applySourceForOutput(state);
    }

    applyFlowVisibility(state, visible);
  };

  const createTreeItem = (groupName, state) => {
    const item = document.createElement('li');
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    const text = document.createElement('span');

    checkbox.type = 'checkbox';
    checkbox.checked = state.visible;
    checkbox.addEventListener('change', () => applyFlowSelection(state, checkbox.checked));
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

      details.open = true;
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
    const flowLayer = svg && findLayer(svg, 'energy-flow-select-many');

    if (!svg || !flowLayer) {
      console.warn('SVG flow layer was not found.');
      isInitializing = false;
      return;
    }

    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.display = 'block';
    setupBackgroundControls(svg);

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
      const pulse = createPulse(svg, path, animationLayer);
      const visible = FLOW_DEFAULTS.has(label);
      applyIdleBaseStyle(path, idlePaths);
      animationLayer.appendChild(pulse.element);

      const state = {
        base: path,
        boundary: flowLayer,
        createInstance: pulse.createInstance,
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
          visible: !isIdlePath(label) && !isCrossPath(label) && isEffectivelyVisible(path, flowLayer),
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
  };

  svgObject.addEventListener('load', initialize);
  setupFullscreenToggle();
})();
