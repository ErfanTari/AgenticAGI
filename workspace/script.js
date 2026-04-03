const display = document.getElementById('display');

let displayValue = '0';
let firstOperand = null;
let waitingForSecondOperand = false;
let operator = null;

function updateDisplay() {
  display.textContent = displayValue;
}