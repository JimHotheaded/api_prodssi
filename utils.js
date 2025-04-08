// Function to find the maximum value in a specific field of the JSON data
function findMax(data, field) {
    if (!data || data.length === 0) return null;
    return data.reduce((max, item) => (item[field] > max ? item[field] : max), data[0][field]);
  }
  
  // Function to find the minimum value in a specific field of the JSON data
  function findMin(data, field) {
    if (!data || data.length === 0) return null;
    return data.reduce((min, item) => (item[field] < min ? item[field] : min), data[0][field]);
  }
  
  // Function to calculate the average value in a specific field of the JSON data
  function calculateAverage(data, field) {
    if (!data || data.length === 0) return null;
    const total = data.reduce((sum, item) => sum + item[field], 0);
    return total / data.length;
  }
  
  function calSum(data, field) {
    if (!data || data.length === 0) return null;
    const total = data.reduce((sum, item) => sum + item[field], 0);
    return total;
  }

  function calCap(data, field) {
    if (!data || data.length === 0) return null;
    const total = data.reduce((sum, item) => sum + item[field], 0);
    return total/6;
  }

  function returnTagName(data) {
    if (!data || data.length === 0) return null;
    return data[0].TagName
  }

  function countValues(data, field, operator, value) {
    if (!data || data.length === 0) return 0;
  
    switch (operator) {
      case '>':
        return data.reduce((count, item) => (item[field] > value ? count + 1 : count), 0);
      case '<':
        return data.reduce((count, item) => (item[field] < value ? count + 1 : count), 0);
      case '>=':
        return data.reduce((count, item) => (item[field] >= value ? count + 1 : count), 0);
      case '<=':
        return data.reduce((count, item) => (item[field] <= value ? count + 1 : count), 0);
      case '==':
        return data.reduce((count, item) => (item[field] == value ? count + 1 : count), 0);
      case '===':
        return data.reduce((count, item) => (item[field] === value ? count + 1 : count), 0);
      case '!=':
        return data.reduce((count, item) => (item[field] != value ? count + 1 : count), 0);
      case '!==':
        return data.reduce((count, item) => (item[field] !== value ? count + 1 : count), 0);
      default:
        throw new Error(`Unknown operator: ${operator}`);
    }
  }
  
  // const total = data.reduce((sum, item) => sum + item[field], 0);
  // return total;
  function calSumFilter(data, field, operator, value) {
    if (!data || data.length === 0) return null;
    
    switch (operator) {
      case '>':
        return data.reduce((count, item) => (item[field] > value ? count + 1 : count), 0);
      case '<':
        return data.reduce((count, item) => (item[field] < value ? count + 1 : count), 0);
      case '>=':
        return data.reduce((count, item) => (item[field] >= value ? count + 1 : count), 0);
      case '<=':
        return data.reduce((count, item) => (item[field] <= value ? count + 1 : count), 0);
      case '==':
        return data.reduce((count, item) => (item[field] == value ? count + 1 : count), 0);
      case '===':
        return data.reduce((count, item) => (item[field] === value ? count + 1 : count), 0);
      case '!=':
        return data.reduce((count, item) => (item[field] != value ? count + 1 : count), 0);
      case '!==':
        return data.reduce((count, item) => (item[field] !== value ? count + 1 : count), 0);
      default:
        throw new Error(`Unknown operator: ${operator}`);
    }
  }

  function generateDateStringsForMonth(year, month, startTime1, endTime1, startTime2, endTime2) {
    const dates = [];
    const daysInMonth = new Date(year, month + 1, 0).getDate();
  
    for (let day = 1; day <= daysInMonth; day++) {
      const dayString = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      dates.push({
        startDateTime1: `${dayString} ${startTime1}`,
        endDateTime1: `${dayString} ${endTime1}`,
        startDateTime2: `${dayString} ${startTime2}`,
        endDateTime2: `${dayString} ${endTime2}`,
      });
    }
  
    return dates;
  }
  
  function calculateCustomTimeFrame(data, field) {
    if (!data || data.length === 0) return 0;
    
  }

  module.exports = {  findMax, 
                      findMin, 
                      calculateAverage, 
                      returnTagName, 
                      countValues, 
                      calculateCustomTimeFrame, 
                      generateDateStringsForMonth,
                      calSum,
                      calCap
                    };